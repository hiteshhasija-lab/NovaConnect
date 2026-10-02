import SwiftUI
import PhotosUI

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

struct CallDirectory: View {
    @EnvironmentObject private var session: AppSession
    @State private var conversations: [Conversation] = []
    @State private var query = ""
    @State private var error: String?
    @State private var loaded = false
    private var filtered: [Conversation] {
        conversations.filter { $0.is_hidden != 1 && (query.isEmpty || $0.displayName.localizedCaseInsensitiveContains(query)) }
            .sorted { ($0.last_message?.created_at ?? "") > ($1.last_message?.created_at ?? "") }
    }
    var body: some View {
        NavigationStack {
            List {
                ConnectionStatus(live: session.live)
                InlineError(text: error)
                Section("Start a call") {
                    ForEach(filtered) { conversation in
                        HStack(spacing: 11) {
                            if conversation.is_group == 1 {
                                Image(systemName: "person.2.fill").foregroundStyle(.blue)
                                    .frame(width: 42, height: 42).background(Color.blue.opacity(0.1), in: Circle())
                            } else if let person = conversation.participants.first {
                                PersonAvatar(person: person, size: 42, overlaysPresence: true)
                            }
                            VStack(alignment: .leading, spacing: 3) {
                                Text(conversation.displayName).font(.body.weight(.medium)).lineLimit(2)
                                if let person = conversation.is_group == 1 ? nil : conversation.participants.first {
                                    Text(person.chatPresence).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                } else { Text("Group chat").font(.caption).foregroundStyle(.secondary) }
                            }.frame(maxWidth: .infinity, alignment: .leading)
                            HStack(spacing: 8) {
                                Button { Task { await start(conversation, video: false) } } label: {
                                    Image(systemName: "phone.fill").frame(width: 36, height: 36).novaGlass(in: Circle(), interactive: true)
                                }.accessibilityLabel("Audio call \(conversation.displayName)")
                                Button { Task { await start(conversation, video: true) } } label: {
                                    Image(systemName: "video.fill").frame(width: 36, height: 36).novaGlass(in: Circle(), interactive: true)
                                }.accessibilityLabel("Video call \(conversation.displayName)")
                            }.buttonStyle(.plain).tint(.blue).fixedSize()
                                .disabled(session.calls.keepsConnection || session.meetings.keepsConnection || !session.live.connected)
                        }.padding(.vertical, 4)
                    }
                }
                if loaded && filtered.isEmpty {
                    ContentUnavailableView("No calls available", systemImage: "phone", description: Text(query.isEmpty ? "Start a chat with someone before calling them." : "No chats match your search."))
                }
            }.listStyle(.plain).navigationTitle("Calls").navigationBarTitleDisplayMode(.inline)
                .searchable(text: $query, prompt: "Search people and groups")
                .overlay { if !loaded && error == nil { ProgressView() } }
                .task { await load() }.refreshable { await load() }
                .onReceive(NotificationCenter.default.publisher(for: .liveUpdate).filter { notification in
                    guard let event = notification.object as? LiveEvent else { return true }
                    return ["presence:update", "message:new", "gcall:state"].contains(event.name)
                }.debounce(for: .milliseconds(350), scheduler: RunLoop.main)) { _ in Task { await load() } }
        }
    }
    private func load() async {
        guard let api = session.api else { return }
        do { conversations = try await api.get("/api/dm"); error = nil; loaded = true }
        catch { self.error = error.localizedDescription; loaded = true }
    }
    private func start(_ conversation: Conversation, video: Bool) async {
        guard !session.meetings.keepsConnection else { error = "Leave the meeting before starting a call."; return }
        await session.calls.start(conversationID: conversation.id, title: conversation.displayName, live: session.live, video: video)
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
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var uploadingPhoto = false
    var body: some View {
        NavigationStack {
            Form {
                if let user = session.user {
                    Section {
                        HStack(spacing: 12) { PersonAvatar(person: user); VStack(alignment: .leading) { Text(user.full_name).font(.headline); Text("@\(user.username)").foregroundStyle(.secondary) } }
                        PhotosPicker(selection: $selectedPhoto, matching: .images) {
                            Label(uploadingPhoto ? "Uploading picture…" : "Change profile picture", systemImage: "photo")
                        }.novaGlassButtons().disabled(uploadingPhoto)
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
                    } catch { self.error = error.localizedDescription } } }.novaGlassButtons()
                    if let feedback { Text(feedback).font(.caption).foregroundStyle(.secondary) }
                    InlineError(text: error)
                }
                Section("Workspace") {
                    NavigationLink { ActivityView() } label: { Label("Activity", systemImage: "bell") }
                    NavigationLink("Upcoming meetings") { MeetingsView() }
                    NavigationLink("Activity") { ActivityView() }
                    NavigationLink("Gemini") { GeminiView() }
                }
                Section("Appearance") {
                    Picker("Theme", selection: $appearance) { Text("System").tag("system"); Text("Light").tag("light"); Text("Dark").tag("dark") }
                }
                Section {
                    LabeledContent("Build", value: "\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Unknown") (\(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "Unknown"))")
                    Text("Native calling and meeting participation are development previews. Background ringing, push notifications and administrative screens are still in development. This build is not ready for TestFlight.").font(.footnote).foregroundStyle(.secondary)
                    Button("Sign out", role: .destructive) { confirmLogout = true }
                    InlineError(text: session.error)
                }
            }.onChange(of: selectedPhoto) { _, item in
                guard let item else { return }
                uploadingPhoto = true
                Task {
                    defer { uploadingPhoto = false; selectedPhoto = nil }
                    do {
                        guard let api = session.api, let data = try await item.loadTransferable(type: Data.self),
                              let original = UIImage(data: data) else { throw APIError(message: "Unable to open this picture.") }
                        let scale = min(1, 1024 / max(original.size.width, original.size.height))
                        let size = CGSize(width: original.size.width * scale, height: original.size.height * scale)
                        let format = UIGraphicsImageRendererFormat(); format.scale = 1
                        let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in original.draw(in: CGRect(origin: .zero, size: size)) }
                        guard let jpeg = image.jpegData(compressionQuality: 0.85) else { throw APIError(message: "Unable to prepare this picture.") }
                        let file = try AttachmentCache.write(jpeg, filename: "profile.jpg")
                        defer { AttachmentCache.remove(file) }
                        try await api.upload("/api/profile-photo", text: "", file: file)
                        session.photoRevision += 1; feedback = "Profile picture updated."; error = nil
                    } catch { self.error = error.localizedDescription }
                }
            }.navigationTitle("You").onAppear { status = session.user?.status ?? "online" }
                .onChange(of: session.user?.status) { _, updated in if let updated { status = updated } }
                .confirmationDialog("Sign out of NovaConnect?", isPresented: $confirmLogout) { Button("Sign out", role: .destructive) { Task { await session.logout() } } }
        }
    }
}
struct MeetingsView: View {
    var title = "Meetings"
    @EnvironmentObject private var session: AppSession
    @State private var meetings: [Meeting] = []
    @State private var error: String?
    @State private var loaded = false
    @State private var showSchedule = false
    @State private var showJoin = false
    var body: some View {
        List {
            InlineError(text: error)
            Section {
                Button { showSchedule = true } label: { Label("Schedule a meeting", systemImage: "calendar.badge.plus") }.novaGlassButtons(prominent: true)
                Button { showJoin = true } label: { Label("Join with a meeting ID", systemImage: "number") }.novaGlassButtons()
            }
            Section("Upcoming") {
                ForEach(meetings) { meeting in
                    VStack(alignment: .leading, spacing: 10) {
                        Text(meeting.title).font(.headline)
                        Label(MeetingDates.range(meeting), systemImage: "clock").font(.subheadline).foregroundStyle(.secondary)
                        if let code = meeting.meet_code {
                            Button("Join meeting") { Task { await session.meetings.join(code, fallbackTitle: meeting.title, live: session.live, callActive: session.calls.keepsConnection) } }
                                .novaGlassButtons(prominent: true).disabled(session.meetings.keepsConnection || session.calls.keepsConnection)
                        }
                    }.padding(.vertical, 5)
                }
            }
            if loaded && meetings.isEmpty { ContentUnavailableView("No upcoming meetings", systemImage: "calendar") }
            Section { ConnectionStatus(live: session.live) }
        }.navigationTitle(title).navigationBarTitleDisplayMode(.inline).task { await load() }.refreshable { await load() }
            .sheet(isPresented: $showSchedule) { ScheduleMeetingSheet { await load() } }
            .sheet(isPresented: $showJoin) { JoinMeetingSheet() }
    }
    private func load() async {
        do { if let api = session.api { meetings = try await api.get("/api/meet/scheduled"); loaded = true; error = nil } }
        catch { self.error = error.localizedDescription }
    }
}

enum MeetingDates {
    private static let localInput: DateFormatter = {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = .current; f.dateFormat = "yyyy-MM-dd'T'HH:mm"; return f
    }()
    static func local(_ date: Date) -> String { localInput.string(from: date) }
    static func range(_ meeting: Meeting) -> String {
        guard let start = Timeline.date(meeting.start_at), let end = Timeline.date(meeting.end_at) else { return Timeline.label(meeting.start_at) }
        return start.formatted(date: .abbreviated, time: .shortened) + " – " + end.formatted(date: start.formatted(date: .numeric, time: .omitted) == end.formatted(date: .numeric, time: .omitted) ? .omitted : .abbreviated, time: .shortened)
    }
}

struct JoinMeetingSheet: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.dismiss) private var dismiss
    @State private var value = ""
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Form {
                Section("Meeting ID or link") {
                    TextField("Paste a meeting ID or link", text: $value).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Text("You may paste the 24-character meeting ID or the complete NovaConnect meeting link.").font(.footnote).foregroundStyle(.secondary)
                }
                InlineError(text: error)
                Button("Join meeting") {
                    guard MeetingCode.parse(value) != nil else { error = "Enter a valid meeting ID or link."; return }
                    dismiss(); Task { await session.meetings.join(value, live: session.live, callActive: session.calls.keepsConnection) }
                }.novaGlassButtons(prominent: true).disabled(value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || session.calls.keepsConnection || session.meetings.keepsConnection)
            }.navigationTitle("Join a meeting").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}

struct ScheduleMeetingSheet: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.dismiss) private var dismiss
    let saved: () async -> Void
    @State private var title = ""
    @State private var start = Date().addingTimeInterval(1800)
    @State private var end = Date().addingTimeInterval(5400)
    @State private var details = ""
    @State private var location = ""
    @State private var allDay = false
    @State private var requestRSVP = true
    @State private var showAs = "busy"
    @State private var recurrence = "none"
    @State private var count = 4
    @State private var query = ""
    @State private var results: [Person] = []
    @State private var selected: [Person] = []
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Form {
                Section("Meeting") {
                    TextField("Title", text: $title)
                    DatePicker("Starts", selection: $start, displayedComponents: allDay ? [.date] : [.date, .hourAndMinute])
                    DatePicker("Ends", selection: $end, in: start..., displayedComponents: allDay ? [.date] : [.date, .hourAndMinute])
                    Toggle("All day", isOn: $allDay)
                    TextField("Location (optional)", text: $location)
                    TextField("Details (optional)", text: $details, axis: .vertical).lineLimit(3...8)
                }
                Section("Attendees") {
                    ForEach(selected) { person in
                        HStack { PersonAvatar(person: person, size: 34); Text(person.full_name); Spacer(); Button { selected.removeAll { $0.id == person.id } } label: { Image(systemName: "xmark.circle.fill") }.buttonStyle(.plain).accessibilityLabel("Remove \(person.full_name)") }
                    }
                    TextField("Search people", text: $query).textInputAutocapitalization(.never).autocorrectionDisabled()
                    ForEach(results.filter { person in !selected.contains(where: { $0.id == person.id }) }.prefix(8)) { person in
                        Button { selected.append(person); query = ""; results = [] } label: { HStack { PersonAvatar(person: person, size: 34); VStack(alignment: .leading) { Text(person.full_name).foregroundStyle(.primary); Text("@\(person.username)").font(.caption).foregroundStyle(.secondary) }; Spacer(); Image(systemName: "plus.circle") } }
                    }
                }
                Section("Options") {
                    Picker("Repeat", selection: $recurrence) { Text("Does not repeat").tag("none"); Text("Daily").tag("daily"); Text("Weekly").tag("weekly"); Text("Monthly").tag("monthly") }
                    if recurrence != "none" { Stepper("\(count) occurrences", value: $count, in: 1...52) }
                    Toggle("Request responses", isOn: $requestRSVP)
                    Picker("Show as", selection: $showAs) { Text("Busy").tag("busy"); Text("Free").tag("free") }
                    LabeledContent("Time zone", value: TimeZone.current.identifier).font(.footnote)
                }
                InlineError(text: error)
            }.navigationTitle("New meeting").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) { Button(busy ? "Scheduling…" : "Schedule") { Task { await schedule() } }.disabled(busy || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || selected.isEmpty || end <= start) }
                }
                .task(id: query) { await search() }
        }
    }
    private func search() async {
        guard let api = session.api else { return }
        do {
            try await Task.sleep(for: .milliseconds(250))
            let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { results = []; return }
            let people: [Person] = try await api.get("/api/users/search", query: [URLQueryItem(name: "q", value: text)])
            if query.trimmingCharacters(in: .whitespacesAndNewlines) == text { results = people.filter { $0.id != session.user?.id } }
        } catch is CancellationError {} catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
    private func schedule() async {
        guard let api = session.api else { return }
        busy = true; error = nil; defer { busy = false }
        let calendar = Calendar.current
        let startValue = allDay ? calendar.startOfDay(for: start) : start
        let rawEnd = allDay ? calendar.startOfDay(for: end) : end
        let endValue = allDay && rawEnd <= startValue ? calendar.date(byAdding: .day, value: 1, to: startValue)! : rawEnd
        do {
            let _: MeetingCreated = try await api.get("/api/meetings", method: "POST", body: [
                "title": title.trimmingCharacters(in: .whitespacesAndNewlines), "attendee_ids": selected.map(\.id),
                "timezone": TimeZone.current.identifier, "start_local": MeetingDates.local(startValue), "end_local": MeetingDates.local(endValue),
                "all_day": allDay, "recurrence": recurrence, "count": recurrence == "none" ? 1 : count,
                "request_rsvp": requestRSVP, "show_as": showAs, "location": location, "details": details,
                "conversation_id": NSNull()
            ])
            await saved(); dismiss()
        } catch { self.error = error.localizedDescription }
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
                HStack { TextField("Ask Gemini", text: $draft, axis: .vertical).lineLimit(1...5); Button("Send") { Task { await send() } }.disabled(busy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }.padding(12).novaGlass(in: RoundedRectangle(cornerRadius: 20)).padding(.horizontal).padding(.vertical, 8)
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
