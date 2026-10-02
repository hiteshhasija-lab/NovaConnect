import SwiftUI
import UniformTypeIdentifiers
import QuickLook

struct ConversationList: View {
    @EnvironmentObject private var session: AppSession
    @State private var rows: [Conversation] = []
    @State private var query = ""
    @State private var error: String?
    @State private var loaded = false
    @State private var filter = "All"
    @State private var newChat = false
    @State private var profile = false
    var filtered: [Conversation] {
        rows.filter {
            $0.is_hidden != 1 && (query.isEmpty || $0.displayName.localizedCaseInsensitiveContains(query)) &&
            (filter != "Unread" || $0.is_unread == 1) &&
            (filter != "Favorites" || $0.is_favorite == 1) &&
            (filter != "Groups" || $0.is_group == 1)
        }.sorted { ($0.last_message?.created_at ?? "") > ($1.last_message?.created_at ?? "") }
    }
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(["All", "Unread", "Favorites", "Groups"], id: \.self) { item in
                            Button { filter = item } label: {
                                Text(item).font(.subheadline.weight(filter == item ? .semibold : .regular))
                                    .padding(.horizontal, 16).padding(.vertical, 9)
                                    .novaGlass(in: Capsule(), interactive: true, tint: filter == item ? Color.blue.opacity(0.12) : nil)
                                    .overlay(Capsule().stroke(filter == item ? Color.blue.opacity(0.35) : Color(.separator).opacity(0.4), lineWidth: 1))
                            }.foregroundStyle(filter == item ? Color.blue : Color.secondary)
                                .accessibilityAddTraits(filter == item ? .isSelected : [])
                        }
                    }.padding(.horizontal, 16).padding(.vertical, 10)
                }
                Divider()
                List {
                    ConnectionStatus(live: session.live).listRowSeparator(.hidden)
                    if let error { InlineError(text: error).listRowSeparator(.hidden) }
                    if loaded && filtered.isEmpty {
                        ContentUnavailableView("No chats here", systemImage: "bubble.left", description: Text("Try another filter or start a new conversation."))
                            .listRowSeparator(.hidden)
                    }
                    ForEach(filtered) { conversation in
                        NavigationLink {
                            ChatTimeline(scope: "dm", id: conversation.id, title: conversation.displayName)
                        } label: {
                            HStack(spacing: 13) {
                                if conversation.is_group == 1 {
                                    Image(systemName: "person.2.fill").foregroundStyle(.blue)
                                        .frame(width: 46, height: 46).background(Color.blue.opacity(0.1), in: Circle())
                                } else if let person = conversation.participants.first { PersonAvatar(person: person) }
                                VStack(alignment: .leading, spacing: 5) {
                                    HStack(alignment: .firstTextBaseline) {
                                        Text(conversation.displayName).font(.body.weight(conversation.is_unread == 1 ? .semibold : .regular)).lineLimit(1)
                                        Spacer(minLength: 4)
                                        if let date = conversation.last_message?.created_at.flatMap(Timeline.date) {
                                            Text(date, format: .dateTime.month(.twoDigits).day(.twoDigits)).font(.caption).foregroundStyle(.secondary)
                                        }
                                    }
                                    HStack {
                                        Text(conversation.last_message?.summary(currentUserID: session.user?.id) ?? "No messages yet")
                                            .font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                                        if conversation.is_unread == 1 { Circle().fill(.blue).frame(width: 7, height: 7).accessibilityLabel("Unread") }
                                    }
                                }
                            }
                        }.listRowSeparator(.hidden)
                            .listRowInsets(EdgeInsets(top: 7, leading: 16, bottom: 7, trailing: 16))
                    }
                }.listStyle(.plain)
                    .overlay { if !loaded && error == nil { ProgressView() } }
                    .refreshable { await load() }
            }
            .background(Color(.systemBackground))
            .navigationTitle("Chat").navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search chats")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { profile = true } label: {
                        if let user = session.user { PersonAvatar(person: user, size: 32) }
                    }.accessibilityLabel("Your profile and status")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { newChat = true } label: { Image(systemName: "square.and.pencil").font(.title3) }
                        .accessibilityLabel("New chat")
                }
            }
            .sheet(isPresented: $newChat) { PeopleList() }
            .sheet(isPresented: $profile) { PresenceSheet().presentationDetents([.medium, .large]).presentationDragIndicator(.visible) }
            .task { await load() }
            .onReceive(NotificationCenter.default.publisher(for: .liveUpdate).filter { notification in
                guard let event = notification.object as? LiveEvent else { return true }
                return ["message:new", "message:update", "message:delete", "reaction:update", "presence:update", "dm:read", "dm:preferences"].contains(event.name)
            }.debounce(for: .milliseconds(350), scheduler: RunLoop.main)) { _ in Task { await load() } }
        }
    }
    private func load() async {
        guard let api = session.api else { return }
        do { rows = try await api.get("/api/dm"); error = nil; loaded = true }
        catch { self.error = error.localizedDescription }
    }
}

struct ChatTimeline: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var navigation: NativeNavigationState
    @Environment(\.dismiss) private var dismiss
    let scope: String
    let id: Int
    let title: String
    @State private var botThinking = false
    @State private var thinkingTimer: Task<Void, Never>?
    @State private var chatPerson: Person?
    @State private var messages: [Message] = []
    @State private var draft = ""
    @State private var error: String?
    @State private var hasMore = false
    @State private var busy = false
    @State private var sending = false
    @State private var loaded = false
    @State private var lastRead = 0
    @State private var refreshPending = false
    @State private var active = false
    @State private var draftBeforeEdit = ""
    @State private var atBottom = true
    @State private var showNewMessages = false
    @State private var scrollAfterSend = false
    @State private var reply: Message?
    @State private var editing: Message?
    @State private var deleting: Message?
    @State private var importFile = false
    @State private var previewURL: URL?
    @State private var attachmentURL: URL?
    private var draftKey: String { "\(scope):\(id)" }
    private var path: String { "/api/\(scope == "dm" ? "dm" : "channels")/\(id)/messages" }
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ConnectionStatus(live: session.live)
                    if hasMore { Button("Load earlier messages") { Task { await load(older: true) } }.disabled(busy).frame(maxWidth: .infinity) }
                    if loaded && messages.isEmpty { ContentUnavailableView("Start the conversation", systemImage: "bubble.left", description: Text("Send your first message below.")) }
                    ForEach(messages) { message in
                        messageView(message).id(message.id)
                    }
                    if botThinking { HStack { BotThinkingBubble(); Spacer() }.id("bot-thinking") }
                    Color.clear.frame(height: 1).id("bottom")
                        .onAppear { atBottom = true; showNewMessages = false }
                        .onDisappear { atBottom = false }
                }.padding()
            }
            .background(Color(.systemGroupedBackground))
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .refreshable { await load() }
            .onChange(of: botThinking) { _, value in if value && atBottom { proxy.scrollTo("bottom", anchor: .bottom) } }
            .onChange(of: messages.last?.id) { _, last in
                if last != nil {
                    if atBottom || scrollAfterSend {
                        withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                        scrollAfterSend = false
                    } else { showNewMessages = true }
                }
            }
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 0) {
                    if showNewMessages { Button("Jump to latest messages") { withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }; showNewMessages = false }.font(.caption).padding(8) }
                    composer
                }
            }
            .navigationTitle("").navigationBarTitleDisplayMode(.inline)
            .toolbar(.hidden, for: .tabBar)
            .toolbar(.hidden, for: .navigationBar)
            .safeAreaInset(edge: .top, spacing: 0) {
                HStack(spacing: 8) {
                    Button { dismiss() } label: {
                        Image(systemName: "chevron.left").frame(width: 44, height: 44).novaGlass(in: Circle(), interactive: true)
                    }.accessibilityLabel("Back to chats")
                    if let chatPerson {
                        PersonAvatar(person: chatPerson, size: 36, overlaysPresence: true)
                    } else {
                        Text(title.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined())
                            .font(.system(size: 13, weight: .bold)).foregroundStyle(.blue)
                            .frame(width: 36, height: 36)
                            .background(Color.blue.opacity(0.12), in: Circle())
                            .accessibilityHidden(true)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title).font(.headline).lineLimit(2)
                        if let chatPerson {
                            Text(chatPerson.chatPresence).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                        .layoutPriority(1).accessibilityElement(children: .combine)
                    if scope == "dm" {
                        HStack(spacing: 8) {
                            Button { Task { await session.calls.start(conversationID: id, title: title, live: session.live) } } label: {
                                Image(systemName: "phone").frame(width: 44, height: 44)
                                    .novaGlass(in: Circle(), interactive: true)
                            }.accessibilityLabel("Start audio call").accessibilityIdentifier("chat.audioCall")
                            Button { Task { await session.calls.start(conversationID: id, title: title, live: session.live, video: true) } } label: {
                                Image(systemName: "video").frame(width: 44, height: 44)
                                    .novaGlass(in: Circle(), interactive: true)
                            }.accessibilityLabel("Start video call").accessibilityIdentifier("chat.videoCall")
                        }.fixedSize()
                    }
                }.buttonStyle(.plain).tint(.blue)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(.bar)
            }
            .task { await refreshChatPerson() }
            .onReceive(NotificationCenter.default.publisher(for: .liveUpdate)) { notification in
                guard scope == "dm" else { return }
                if notification.object == nil { Task { await refreshChatPerson() }; return }
                if let event = notification.object as? LiveEvent, event.name == "presence:update", event.payload["userId"] as? Int == chatPerson?.id {
                    Task { await refreshChatPerson() }
                }
            }
            .task { active = true; draft = session.drafts[draftKey] ?? ""; await load() }
            .onChange(of: draft) { _, value in if editing == nil { session.drafts[draftKey] = value } }
            .onAppear { navigation.barHidden = true }
            .onDisappear { navigation.barHidden = false; active = false; thinkingTimer?.cancel(); botThinking = false; AttachmentCache.remove(previewURL) }
            .onChange(of: session.live.connected) { _, connected in if !connected { thinkingTimer?.cancel(); botThinking = false } }
            .onReceive(NotificationCenter.default.publisher(for: .liveUpdate)) { notification in
                guard let event = notification.object as? LiveEvent, event.name == "bot:thinking",
                      event.payload["scope"] as? String == scope, event.payload["id"] as? Int == id else { return }
                thinkingTimer?.cancel()
                botThinking = event.payload["thinking"] as? Bool == true
                if botThinking {
                    thinkingTimer = Task {
                        do { try await Task.sleep(nanoseconds: 30_000_000_000) } catch { return }
                        botThinking = false
                    }
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .liveUpdate).filter { notification in
                guard let event = notification.object as? LiveEvent else { return true }
                return ["message:new", "message:update", "message:delete", "reaction:update"].contains(event.name)
            }.debounce(for: .milliseconds(250), scheduler: RunLoop.main)) { notification in
                guard active else { return }
                if let event = notification.object as? LiveEvent,
                   !["message:new", "message:update", "message:delete", "reaction:update"].contains(event.name) { return }
                Task { await load() }
            }
            .fileImporter(isPresented: $importFile, allowedContentTypes: [.item]) { result in
                do { attachmentURL = try result.get() } catch { self.error = error.localizedDescription }
            }
            .quickLookPreview($previewURL)
            .confirmationDialog("Delete this message?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
                Button("Delete message", role: .destructive) { if let deleting { Task { await remove(deleting) } } }
                Button("Cancel", role: .cancel) { deleting = nil }
            }
        }
    }
    private func refreshChatPerson() async {
        guard scope == "dm", let api = session.api else { return }
        do {
            let detail: ChatParticipants = try await api.get("/api/dm/\(id)")
            let others = detail.participants.filter { $0.id != session.user?.id }
            chatPerson = others.count == 1 ? others.first : nil
        } catch { chatPerson = nil }
    }
    private func messageView(_ message: Message) -> some View {
        let mine = message.author.id == session.user?.id
        return HStack(alignment: .top) {
            if mine { Spacer(minLength: 24) }
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(mine ? "You" : message.author.full_name).font(.caption.bold())
                    Text(Timeline.label(message.created_at)).font(.caption2).foregroundStyle(.secondary)
                }
                if message.deleted { Text("This message was deleted").italic().foregroundStyle(.secondary) }
                else {
                    let content = QuotedBody(message.body)
                    if let quote = content.quote {
                        Text(quote).font(.caption).foregroundStyle(.secondary)
                            .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8))
                    }
                    Text((try? AttributedString(markdown: content.body, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(content.body)).textSelection(.enabled)
                    if let metadata = message.metadata {
                        WorkflowCard(metadata: metadata, messageID: message.id, scope: scope, chatID: id) { await load() }
                    }
                    ForEach(message.attachments) { attachment in
                        Button { Task { await download(attachment) } } label: {
                            Label(attachment.original_name, systemImage: "doc").font(.subheadline).lineLimit(2)
                        }.novaGlassButtons()
                    }
                    if !message.reactions.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) { HStack { ForEach(message.reactions) { reaction in
                            Button("\(reaction.emoji) \(reaction.count)") { Task { await react(message, emoji: reaction.emoji) } }
                                .font(.caption).novaGlassButtons().tint(reaction.mine ? .blue : .secondary)
                        } } }
                    }
                    if message.edited { Text("Edited").font(.caption2).foregroundStyle(.secondary) }
                }
            }
            .padding(12).background(mine ? Color(.secondarySystemGroupedBackground) : Color.blue.opacity(0.16), in: RoundedRectangle(cornerRadius: 12))
            .contextMenu {
                if !message.deleted {
                    Button("Reply", systemImage: "arrowshape.turn.up.left") { if editing != nil { draft = draftBeforeEdit }; editing = nil; reply = message }
                    ForEach(["👍", "❤️", "😂", "✅"], id: \.self) { emoji in Button(emoji) { Task { await react(message, emoji: emoji) } } }
                    Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.body }
                    if mine {
                        Button("Edit", systemImage: "pencil") { if editing == nil { draftBeforeEdit = draft }; editing = message; draft = message.body; reply = nil }
                        Button("Delete", systemImage: "trash", role: .destructive) { deleting = message }
                    }
                }
            }
            if !mine { Spacer(minLength: 24) }
        }
    }
    private var composer: some View {
        VStack(spacing: 8) {
            InlineError(text: error)
            if let reply {
                HStack {
                    VStack(alignment: .leading) { Text(reply.author.full_name).font(.caption.bold()); Text(reply.body).font(.caption).lineLimit(2) }
                    Spacer()
                    Button { self.reply = nil } label: { Image(systemName: "xmark.circle.fill") }.accessibilityLabel("Cancel reply")
                }.padding(10).background(Color.blue.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            }
            if editing != nil { HStack { Text("Editing message").font(.caption); Spacer(); Button("Cancel") { draft = draftBeforeEdit; editing = nil } } }
            if let attachmentURL {
                HStack { Label(attachmentURL.lastPathComponent, systemImage: "paperclip").font(.caption).lineLimit(1); Spacer(); Button("Remove") { self.attachmentURL = nil } }
            }
            HStack(alignment: .bottom) {
                Button { importFile = true } label: { Image(systemName: "plus").font(.title3).frame(minWidth: 44, minHeight: 44).novaGlass(in: Circle(), interactive: true) }
                    .accessibilityLabel("Attach a file").disabled(sending || editing != nil)
                TextField("Type a message", text: $draft, axis: .vertical).lineLimit(1...6).padding(10)
                    .novaGlass(in: RoundedRectangle(cornerRadius: 18))
                Button { Task { await send() } } label: {
                    if sending { ProgressView().frame(width: 44, height: 44) }
                    else { Image(systemName: "paperplane.fill").font(.title2).frame(minWidth: 44, minHeight: 44).novaGlass(in: Circle(), interactive: true, tint: .blue.opacity(0.12)) }
                }.accessibilityLabel(editing == nil ? "Send message" : "Save message")
                    .disabled(sending || (draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachmentURL == nil))
            }
        }.disabled(sending).padding(.horizontal).padding(.vertical, 8).background(.bar)
    }
    private func load(older: Bool = false) async {
        guard let api = session.api else { return }
        if busy { if !older { refreshPending = true }; return }
        busy = true
        defer {
            busy = false
            if refreshPending && active { refreshPending = false; Task { await load() } }
        }
        do {
            if older {
                let query = messages.first.map { [URLQueryItem(name: "before", value: String($0.id))] } ?? []
                let page: MessagePage = try await api.get(path, query: query)
                messages = MessageHistory.merge(messages, page.messages); hasMore = page.has_more
            } else {
                let page = try await MessageHistory.refresh(api: api, path: path, current: messages)
                messages = page.messages; hasMore = page.has_more
            }
            loaded = true; error = nil
            if active && scope == "dm", let last = messages.last, last.id > lastRead { try await api.markConversationRead(id, through: last.id); lastRead = last.id }
        } catch {
            if (error as? APIError)?.statusCode == 403 { messages = []; hasMore = false }
            if !Task.isCancelled { self.error = error.localizedDescription }
        }
    }
    private func send() async {
        guard let api = session.api else { return }
        sending = true; defer { sending = false }
        let originalDraft = draft
        var text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if let reply { text = "> \(reply.author.full_name) \(Timeline.label(reply.created_at))\n> \(reply.body.replacingOccurrences(of: "\n", with: "\n> "))\n\n" + text }
        do {
            if let editing { try await api.send("/api/messages/\(editing.id)", method: "PUT", body: ["body": text]) }
            else if let attachmentURL { try await api.upload(path, text: text, file: attachmentURL) }
            else { try await api.send(path, body: ["body": text]) }
            if draft == originalDraft { draft = editing == nil ? "" : draftBeforeEdit }
            session.drafts[draftKey] = draft
            reply = nil; editing = nil; attachmentURL = nil; error = nil; scrollAfterSend = true
            await load()
        } catch { self.error = error.localizedDescription }
    }
    private func react(_ message: Message, emoji: String) async {
        do { try await session.api?.send("/api/messages/\(message.id)/reactions", body: ["emoji": emoji]); await load() }
        catch { self.error = error.localizedDescription }
    }
    private func remove(_ message: Message) async {
        do { try await session.api?.send("/api/messages/\(message.id)", method: "DELETE"); deleting = nil; await load() }
        catch { self.error = error.localizedDescription }
    }
    private func download(_ attachment: Attachment) async {
        guard let api = session.api else { return }
        do {
            let data = try await api.data(api.request("/api/attachments/\(attachment.id)/download"))
            AttachmentCache.remove(previewURL)
            previewURL = try AttachmentCache.write(data, filename: attachment.original_name)
        } catch { self.error = error.localizedDescription }
    }
}
