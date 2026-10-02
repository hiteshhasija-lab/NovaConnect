import SwiftUI

@MainActor final class AppSession: ObservableObject {
    @Published var user: Person?
    @Published var error: String?
    @Published var busy = false
    @Published var photoRevision = 0
    @Published var server: String = UserDefaults.standard.string(forKey: "native.server") ?? "https://novaconnect.lab.sps"
    @Published var restoring = true
    var api: APIClient?
    let live = LiveConnection()
    let calls = NativeCalls()
    let meetings = NativeMeetings()
    var drafts: [String: String] = [:]
    func login(username: String, password: String) async {
        guard let url = APIClient.serverURL(server) else { error = "Enter an HTTPS server address without a path."; return }
        busy = true; error = nil
        defer { busy = false }
        let client = APIClient(baseURL: url)
        do {
            let response: SessionResponse = try await client.get("/api/mobile/login", method: "POST", body: ["username": username, "password": password])
            try SessionVault.save(url)
            api = client; user = response.user
            UserDefaults.standard.set(server, forKey: "native.server")
            live.start(client)
        } catch { self.error = error.localizedDescription }
    }
    func restore() async {
        defer { restoring = false }
        guard let url = APIClient.serverURL(server) else { return }
        let client = APIClient(baseURL: url)
        SessionVault.restore(url)
        guard !(HTTPCookieStorage.shared.cookies(for: url) ?? []).isEmpty else { return }
        do {
            let response: SessionResponse = try await client.get("/api/mobile/session")
            api = client; user = response.user; live.start(client)
        } catch {
            if (error as? APIError)?.statusCode == 401 { SessionVault.delete(url); client.clearCookies() }
            self.error = error.localizedDescription
        }
    }
    func logout() async {
        do { try await api?.send("/api/mobile/logout") }
        catch { self.error = error.localizedDescription; return }
        expire()
    }
    func expire() {
        calls.disconnected(); meetings.disconnected(); live.stop(); if let api { SessionVault.delete(api.baseURL); api.clearCookies() }; api = nil; user = nil; drafts.removeAll(); AttachmentCache.clear()
    }
}

@main struct NativeNovaConnectApp: App {
    @StateObject private var session = AppSession()
    @Environment(\.scenePhase) private var phase
    @AppStorage("native.appearance") private var appearance = "system"
    var body: some Scene {
        WindowGroup {
            Group {
                if session.restoring { ProgressView("Connecting…") }
                else if session.user != nil { NativeRoot() }
                else { NativeLogin() }
            }
            .environmentObject(session)
            .task { await session.restore() }
            .tint(Color.blue)
            .preferredColorScheme(appearance == "system" ? nil : (appearance == "dark" ? .dark : .light))
            .onReceive(NotificationCenter.default.publisher(for: .sessionExpired)) { notification in
                if let source = notification.object as? APIClient, source === session.api { session.expire() }
            }
            .onReceive(NotificationCenter.default.publisher(for: .liveUpdate)) { notification in
                if let event = notification.object as? LiveEvent { session.calls.event(event, live: session.live); session.meetings.event(event, live: session.live) }
                if let event = notification.object as? LiveEvent, event.name == "presence:update",
                   let id = event.payload["userId"] as? Int, id == session.user?.id,
                   let status = event.payload["status"] as? String { session.user?.status = status }
            }
            .onChange(of: phase) { _, next in
                if next != .inactive { session.calls.setForeground(next == .active); session.meetings.setForeground(next == .active) }
                if next == .active, session.user != nil, !session.live.connected, let api = session.api { session.live.start(api) }
                if next == .background, !session.calls.keepsConnection, !session.meetings.keepsConnection { session.live.enterBackground() }
            }
        }
    }
}

struct NativeRoot: View {
    @EnvironmentObject private var session: AppSession
    var body: some View { CallRoot(calls: session.calls, meetings: session.meetings, live: session.live) }
}
struct CallRoot: View {
    @ObservedObject var calls: NativeCalls
    @ObservedObject var meetings: NativeMeetings
    @ObservedObject var live: LiveConnection
    var body: some View {
        NativeTabs().fullScreenCover(isPresented: $calls.visible) { NativeCallView(calls: calls) }
            .fullScreenCover(isPresented: $meetings.visible) { NativeMeetingView(meetings: meetings) }
            .onChange(of: calls.keepsConnection) { _, active in
                if !active, !meetings.keepsConnection, UIApplication.shared.applicationState == .background { live.enterBackground() }
            }
            .onChange(of: meetings.keepsConnection) { _, active in
                if !active, !calls.keepsConnection, UIApplication.shared.applicationState == .background { live.enterBackground() }
            }
            .onChange(of: live.connected) { _, connected in if !connected { calls.disconnected(); meetings.disconnected() } }
    }
}

struct NativeLogin: View {
    @EnvironmentObject private var session: AppSession
    @State private var username = ""
    @State private var password = ""
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 16) {
                        Image("Logo").resizable().scaledToFit().frame(width: 52, height: 52)
                        VStack(alignment: .leading) {
                            Text("NovaConnect").font(.title2.bold())
                            Text("Native iOS preview").foregroundStyle(.secondary)
                        }
                    }.padding(.vertical, 20)
                }
                Section("Your server") {
                    TextField("https://your-server", text: $session.server)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        .accessibilityIdentifier("serverAddress")
                }
                Section("Sign in") {
                    TextField("Username", text: $username).textContentType(.username)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("Password", text: $password).textContentType(.password)
                    Button {
                        Task { await session.login(username: username, password: password); password = "" }
                    } label: {
                        HStack { Text("Sign in"); Spacer(); if session.busy { ProgressView() } else { Image(systemName: "arrow.right") } }
                    }.novaGlassButtons(prominent: true).disabled(session.busy || username.isEmpty || password.isEmpty)
                }
                if let error = session.error { Section { Text(error).foregroundStyle(.red) } }
                Section {
                    Text("Connect through your organization’s network or VPN. Your server needs the native mobile API and a certificate trusted by this iPhone.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }.navigationTitle("Welcome")
        }
    }
}

struct NativeTabs: View {
    @State private var selection: NativeDestination = .chat
    @StateObject private var navigation = NativeNavigationState()
    var body: some View {
        Group {
            switch selection {
            case .activity: NavigationStack { ActivityView() }
            case .chat: ConversationList()
            case .calendar: NavigationStack { MeetingsView(title: "Calendar") }
            case .calls: CallDirectory()
            case .teams: TeamList()
            case .people: PeopleList()
            case .more: NativeMore()
            }
        }
        .environmentObject(navigation)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !navigation.barHidden { CompactBottomNavigation(selection: $selection) }
        }
    }
}

enum NativeDestination: String, CaseIterable, Identifiable {
    case activity, chat, calendar, calls, teams, people, more
    var id: String { rawValue }
    var label: String {
        switch self { case .activity: "Activity"; case .chat: "Chat"; case .calendar: "Calendar"; case .calls: "Calls"; case .teams: "Teams"; case .people: "People"; case .more: "More" }
    }
    var symbol: String {
        switch self { case .activity: "bell"; case .chat: "bubble.left.and.bubble.right"; case .calendar: "calendar"; case .calls: "phone"; case .teams: "person.3"; case .people: "person.crop.rectangle"; case .more: "ellipsis" }
    }
}

@MainActor final class NativeNavigationState: ObservableObject { @Published var barHidden = false }

struct CompactBottomNavigation: View {
    @Binding var selection: NativeDestination
    var body: some View {
        HStack(spacing: 0) {
            ForEach(NativeDestination.allCases) { destination in
                Button {
                    selection = destination
                } label: {
                    VStack(spacing: 3) {
                        Image(systemName: destination.symbol).font(.system(size: 19, weight: selection == destination ? .bold : .medium))
                            .frame(height: 22)
                        Text(destination.label).font(.system(size: 10.5, weight: selection == destination ? .semibold : .medium)).lineLimit(1).minimumScaleFactor(0.78)
                    }.foregroundStyle(selection == destination ? Color.blue : Color.primary.opacity(0.76))
                        .frame(maxWidth: .infinity, minHeight: 49).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityLabel(destination.label)
                    .accessibilityAddTraits(selection == destination ? .isSelected : [])
            }
        }.padding(.horizontal, 2).padding(.top, 3)
            .background(.bar).overlay(alignment: .top) { Divider() }
    }
}

struct PersonAvatar: View {
    @EnvironmentObject private var session: AppSession
    @State private var photo: UIImage?
    let person: Person
    var size: CGFloat = 46
    var showsPresence = true
    var overlaysPresence = false
    var body: some View {
        HStack(alignment: .bottom, spacing: 3) {
            ZStack {
                Circle().fill(Color.blue.opacity(0.12))
                if let photo { Image(uiImage: photo).resizable().scaledToFill() }
                else { Text(person.initials).font(.system(size: size * 0.34, weight: .bold)) }
            }.frame(width: size, height: size).clipShape(Circle())
            if showsPresence && !overlaysPresence {
            Image(systemName: presenceSymbol)
                .font(.system(size: size <= 32 ? 12 : 14, weight: .bold))
                .foregroundStyle(presenceColor)
                .frame(width: size <= 32 ? 14 : 16, height: size <= 32 ? 14 : 16)
                .accessibilityLabel(person.status ?? "Offline")
            }
        }
        .overlay(alignment: .bottomTrailing) {
            if showsPresence && overlaysPresence {
                Image(systemName: presenceSymbol)
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(presenceColor)
                    .frame(width: 16, height: 16)
                    .background(Color(uiColor: .systemBackground), in: Circle())
            }
        }
        .fixedSize()
        .task(id: "\(person.id):\(session.photoRevision)") {
            photo = nil
            guard let api = session.api else { return }
            do { photo = UIImage(data: try await api.data(api.request("/api/profile-photo/\(person.id)"))) }
            catch { photo = nil }
        }
        .accessibilityHidden(true)
    }

    private var presenceSymbol: String {
        switch person.status {
        case "online": return "checkmark.circle.fill"
        case "dnd": return "minus.circle.fill"
        case "busy", "incall", "inmeeting", "presenting": return "circle.fill"
        case "away", "brb": return "clock.fill"
        default: return "xmark.circle"
        }
    }
    private var presenceColor: Color {
        switch person.status { case "online": return .green; case "busy", "dnd", "incall", "inmeeting", "presenting": return .red; case "away", "brb": return .orange; default: return .gray }
    }
}
struct InlineError: View {
    let text: String?
    var body: some View { if let text { Text(text).font(.footnote).foregroundStyle(.red).padding().accessibilityAddTraits(.updatesFrequently) } }
}
struct ConnectionStatus: View {
    @ObservedObject var live: LiveConnection
    var body: some View {
        if !live.connected { Label("Reconnecting… Pull to refresh meanwhile.", systemImage: "wifi.slash").font(.caption).foregroundStyle(.secondary).padding(8) }
    }
}
