import SwiftUI

struct PeopleList: View {
    @EnvironmentObject private var session: AppSession
    @State private var query = ""
    @State private var people: [Person] = []
    @State private var selected = Set<Int>()
    @State private var conversationID: Int?
    @State private var conversationName = ""
    @State private var error: String?
    @State private var busy = false
    var body: some View {
        NavigationStack {
            List {
                InlineError(text: error)
                Section {
                    ForEach(people) { person in
                        Button {
                            if selected.contains(person.id) { selected.remove(person.id) } else { selected.insert(person.id) }
                        } label: {
                            HStack(spacing: 12) {
                                PersonAvatar(person: person)
                                VStack(alignment: .leading) { Text(person.full_name).foregroundStyle(.primary); Text("@\(person.username) · \(person.status ?? "offline")").font(.caption).foregroundStyle(.secondary) }
                                Spacer()
                                Image(systemName: selected.contains(person.id) ? "checkmark.circle.fill" : "circle").foregroundStyle(.blue)
                            }.padding(.vertical, 4)
                        }
                    }
                } footer: { Text("Select one person for a direct message, or several for a group. Search to find additional people.") }
                if people.isEmpty { ContentUnavailableView.search(text: query) }
                Button(selected.count > 1 ? "Start group conversation (\(selected.count))" : "Start conversation") { Task { await start() } }
                    .disabled(selected.isEmpty || busy)
            }.listStyle(.plain).navigationTitle("People").navigationBarTitleDisplayMode(.inline).searchable(text: $query, prompt: "Name, username or email")
                .task(id: query) { do { try await Task.sleep(for: .milliseconds(300)); await load() } catch {} }
                .refreshable { await load() }
                .onReceive(NotificationCenter.default.publisher(for: .liveUpdate).debounce(for: .milliseconds(500), scheduler: RunLoop.main)) { _ in Task { await load() } }
                .navigationDestination(isPresented: Binding(get: { conversationID != nil }, set: { if !$0 { conversationID = nil } })) {
                    if let conversationID { ChatTimeline(scope: "dm", id: conversationID, title: conversationName) }
                }
        }
    }
    private func load() async {
        guard let api = session.api else { return }
        let search = query
        do {
            let result: [Person] = try await api.get("/api/users/search", query: [URLQueryItem(name: "q", value: search)])
            if search == query { people = result; error = nil }
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
    private func start() async {
        guard let api = session.api else { return }
        busy = true; defer { busy = false }
        do {
            let result: IDResponse = try await api.get("/api/dm", method: "POST", body: ["user_ids": Array(selected)])
            conversationName = selected.count > 1 ? "Group conversation" : people.first(where: { selected.contains($0.id) })?.full_name ?? "Conversation"
            conversationID = result.id
        } catch { self.error = error.localizedDescription }
    }
}

struct TeamList: View {
    @EnvironmentObject private var session: AppSession
    @State private var teams: [Team] = []
    @State private var error: String?
    @State private var loaded = false
    var body: some View {
        NavigationStack {
            List {
                InlineError(text: error)
                ForEach(teams.filter { $0.is_member == true }) { team in
                    NavigationLink { ChannelList(team: team) } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            Label(team.name, systemImage: "square.stack.3d.up").font(.headline)
                            if let description = team.description { Text(description).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                        }.padding(.vertical, 5)
                    }
                }
                if loaded && !teams.contains(where: { $0.is_member == true }) { ContentUnavailableView("No teams yet", systemImage: "person.3", description: Text("Your teams will appear here once you join them.")) }
            }.listStyle(.plain).navigationTitle("Teams").navigationBarTitleDisplayMode(.inline).task { await load() }.refreshable { await load() }
        }
    }
    private func load() async {
        do { if let api = session.api { teams = try await api.get("/api/teams"); loaded = true; error = nil } }
        catch { self.error = error.localizedDescription }
    }
}
struct ChannelList: View {
    let team: Team
    @EnvironmentObject private var session: AppSession
    @State private var channels: [Channel] = []
    @State private var error: String?
    var body: some View {
        List {
            InlineError(text: error)
            ForEach(channels) { channel in
                NavigationLink { ChatTimeline(scope: "channel", id: channel.id, title: channel.name) } label: { Label(channel.name, systemImage: "number") }
            }
        }.listStyle(.plain).navigationTitle(team.name).navigationBarTitleDisplayMode(.inline).task { await load() }.refreshable { await load() }
    }
    private func load() async {
        do { if let api = session.api { let result: TeamDetail = try await api.get("/api/teams/\(team.id)"); channels = result.channels; error = nil } }
        catch { self.error = error.localizedDescription }
    }
}

struct NativeMore: View {
    @EnvironmentObject private var session: AppSession
    @AppStorage("native.appearance") private var appearance = "system"
    @State private var status = "online"
    @State private var savingPresence = false
    @State private var statusMessage = ""
    @State private var feedback: String?
    @State private var error: String?
    @State private var confirmLogout = false
    var body: some View {
        NavigationStack {
            Form {
                if let user = session.user {
                    Section {
                        HStack(spacing: 12) { PersonAvatar(person: user); VStack(alignment: .leading) { Text(user.full_name).font(.headline); Text("@\(user.username)").foregroundStyle(.secondary) } }
                        ConnectionStatus(live: session.live)
                    }
                }
                Section("Your presence") {
                    Picker("Status", selection: Binding(get: { status }, set: { selected in
                        guard selected != status, !savingPresence else { return }
                        let previous = status
                        status = selected; savingPresence = true; error = nil
                        Task {
                            defer { savingPresence = false }
                            do { try await session.live.presence(selected) }
                            catch { status = session.user?.status ?? previous; self.error = error.localizedDescription }
                        }
                    })) {
                        Text("Available").tag("online"); Text("Busy").tag("busy"); Text("Do not disturb").tag("dnd")
                        Text("Be right back").tag("brb"); Text("Away").tag("away"); Text("Appear offline").tag("offline")
                    }
                    .disabled(savingPresence)
                    TextField("Status message", text: $statusMessage, axis: .vertical)
                    Button("Save status message") { Task { do {
                        try await session.api?.send("/api/profile/status-message", method: "PATCH", body: ["status_message": statusMessage, "clear_after": "today"])
                        feedback = "Status message saved until the end of today."; error = nil
                    } catch { self.error = error.localizedDescription } } }
                    if let feedback { Text(feedback).font(.caption).foregroundStyle(.secondary) }
                    InlineError(text: error)
                }
                Section("Workspace") {
                    NavigationLink("Upcoming meetings") { MeetingsView() }
                    NavigationLink("Activity") { ActivityView() }
                    NavigationLink("Gemini") { GeminiView() }
                }
                Section("Appearance") {
                    Picker("Theme", selection: $appearance) { Text("System").tag("system"); Text("Light").tag("light"); Text("Dark").tag("dark") }
                }
                Section {
                    LabeledContent("Build", value: "\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Unknown") (\(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "Unknown"))")
                    Text("Native calling, push notifications, meeting participation and administrative screens are still in development. This build is not yet ready for TestFlight.").font(.footnote).foregroundStyle(.secondary)
                    Button("Sign out", role: .destructive) { confirmLogout = true }
                    InlineError(text: session.error)
                }
            }.navigationTitle("You").onAppear { status = session.user?.status ?? "online" }
                .onChange(of: session.user?.status) { _, updated in if let updated { status = updated } }
                .confirmationDialog("Sign out of NovaConnect?", isPresented: $confirmLogout) { Button("Sign out", role: .destructive) { Task { await session.logout() } } }
        }
    }
}
struct MeetingsView: View {
    @EnvironmentObject private var session: AppSession
    @State private var meetings: [Meeting] = []
    @State private var error: String?
    @State private var loaded = false
    var body: some View {
        List {
            InlineError(text: error)
            ForEach(meetings) { meeting in VStack(alignment: .leading, spacing: 8) { Text(meeting.title).font(.headline); Text(Timeline.label(meeting.start_at)).font(.subheadline).foregroundStyle(.secondary) } }
            if loaded && meetings.isEmpty { ContentUnavailableView("No upcoming meetings", systemImage: "calendar") }
            Section { Text("This preview displays your schedule. Native meeting participation is not available yet.").font(.footnote).foregroundStyle(.secondary) }
        }.navigationTitle("Meetings").task { await load() }.refreshable { await load() }
    }
    private func load() async {
        do { if let api = session.api { meetings = try await api.get("/api/meet/scheduled"); loaded = true; error = nil } }
        catch { self.error = error.localizedDescription }
    }
}
struct ActivityView: View {
    @EnvironmentObject private var session: AppSession
    @State private var activities: [Activity] = []
    @State private var error: String?
    var body: some View {
        List {
            InlineError(text: error)
            ForEach(activities) { activity in
                VStack(alignment: .leading, spacing: 8) {
                    Text(activity.actor_name ?? "NovaConnect").font(.headline)
                    Text(activity.body)
                    if activity.is_read == 0 { Button("Mark read") { Task { do { try await session.api?.send("/api/notifications/\(activity.id)/read"); await load() } catch { self.error = error.localizedDescription } } } }
                }.padding(.vertical, 5)
            }
        }.navigationTitle("Activity").task { await load() }.refreshable { await load() }
    }
    private func load() async {
        do { if let api = session.api { let response: Activities = try await api.get("/api/notifications"); activities = response.notifications; error = nil } }
        catch { self.error = error.localizedDescription }
    }
}
struct GeminiView: View {
    @EnvironmentObject private var session: AppSession
    @State private var messages: [AIMessage] = []
    @State private var draft = ""
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        List {
            ForEach(messages) { message in VStack(alignment: .leading, spacing: 8) { Text(message.role == "user" ? "You" : "Gemini").font(.caption.bold()); Text(message.body).textSelection(.enabled) } }
            InlineError(text: error)
        }.navigationTitle("Gemini").task { await load() }
            .safeAreaInset(edge: .bottom) {
                HStack { TextField("Ask Gemini", text: $draft, axis: .vertical).lineLimit(1...5); Button("Send") { Task { await send() } }.disabled(busy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }.padding().background(.bar)
            }
    }
    private func load() async {
        do { if let api = session.api { let response: AIMessages = try await api.get("/api/ai/messages"); messages = response.messages; error = nil } }
        catch { self.error = error.localizedDescription }
    }
    private func send() async {
        busy = true; defer { busy = false }
        let text = draft
        do { try await session.api?.send("/api/ai/messages", body: ["body": text]); if draft == text { draft = "" }; await load() }
        catch { self.error = error.localizedDescription }
    }
}


struct PresenceSheet: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.dismiss) private var dismiss
    @State private var saving = false
    @State private var error: String?
    private let options: [(String, String, String, Color)] = [
        ("online", "Available", "checkmark.circle.fill", .green),
        ("busy", "Busy", "circle.fill", .red),
        ("dnd", "Do not disturb", "minus.circle.fill", .red),
        ("brb", "Be right back", "clock.fill", .orange),
        ("away", "Away", "clock.fill", .orange),
        ("offline", "Appear offline", "xmark.circle", .gray)
    ]
    var body: some View {
        NavigationStack {
            List {
                ForEach(options, id: \.0) { option in
                    Button {
                        saving = true; error = nil
                        Task {
                            defer { saving = false }
                            do { try await session.live.presence(option.0); dismiss() }
                            catch { self.error = error.localizedDescription }
                        }
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: option.2).foregroundStyle(option.3).frame(width: 22)
                            Text(option.1).foregroundStyle(.primary)
                            Spacer()
                            if session.user?.status == option.0 { Image(systemName: "checkmark").foregroundStyle(.blue) }
                        }.frame(minHeight: 36)
                    }.disabled(saving)
                    .accessibilityAddTraits(session.user?.status == option.0 ? .isSelected : [])
                }
                if let error { InlineError(text: error) }
            }
            .navigationTitle("Live status").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
