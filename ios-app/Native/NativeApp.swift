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
        calls.disconnected(); live.stop(); if let api { SessionVault.delete(api.baseURL); api.clearCookies() }; api = nil; user = nil; drafts.removeAll(); AttachmentCache.clear()
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
                if let event = notification.object as? LiveEvent { session.calls.event(event, live: session.live) }
                if let event = notification.object as? LiveEvent, event.name == "presence:update",
                   let id = event.payload["userId"] as? Int, id == session.user?.id,
                   let status = event.payload["status"] as? String { session.user?.status = status }
            }
            .onChange(of: phase) { _, next in
                if next != .inactive { session.calls.setForeground(next == .active) }
                if next == .active, session.user != nil, !session.live.connected, let api = session.api { session.live.start(api) }
                if next == .background, !session.calls.keepsConnection { session.live.stop() }
            }
        }
    }
}

struct NativeRoot: View {
    @EnvironmentObject private var session: AppSession
    var body: some View { CallRoot(calls: session.calls, live: session.live) }
}
struct CallRoot: View {
    @ObservedObject var calls: NativeCalls
    @ObservedObject var live: LiveConnection
    var body: some View {
        NativeTabs().fullScreenCover(isPresented: $calls.visible) { NativeCallView(calls: calls) }
            .onChange(of: calls.keepsConnection) { _, active in
                if !active, UIApplication.shared.applicationState == .background { live.stop() }
            }
            .onChange(of: live.connected) { _, connected in if !connected { calls.disconnected() } }
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
    @State private var selection = 1
    var body: some View {
        TabView(selection: $selection) {
            NavigationStack { ActivityView() }.tabItem { Label("Activity", systemImage: "bell") }.tag(0)
            ConversationList().tabItem { Label("Chat", systemImage: "bubble.left.and.bubble.right") }.tag(1)
            TeamList().tabItem { Label("Teams", systemImage: "person.3") }.tag(2)
            PeopleList().tabItem { Label("People", systemImage: "person.crop.rectangle") }.tag(3)
            NativeMore().tabItem { Label("More", systemImage: "ellipsis") }.tag(4)
        }

    }
}

struct PersonAvatar: View {
    @EnvironmentObject private var session: AppSession
    @State private var photo: UIImage?
    let person: Person
    var size: CGFloat = 46
    var showsPresence = true
    var body: some View {
        HStack(alignment: .bottom, spacing: 3) {
            ZStack {
                Circle().fill(Color.blue.opacity(0.12))
                if let photo { Image(uiImage: photo).resizable().scaledToFill() }
                else { Text(person.initials).font(.system(size: size * 0.34, weight: .bold)) }
            }.frame(width: size, height: size).clipShape(Circle())
            if showsPresence {
            Image(systemName: presenceSymbol)
                .font(.system(size: size <= 32 ? 12 : 14, weight: .bold))
                .foregroundStyle(presenceColor)
                .frame(width: size <= 32 ? 14 : 16, height: size <= 32 ? 14 : 16)
                .accessibilityLabel(person.status ?? "Offline")
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
