import SwiftUI
import AVFoundation
import WebRTC

struct LobbyPerson: Identifiable, Equatable {
    let peerID: String
    let userID: Int
    let name: String
    var id: String { peerID }
}

@MainActor final class NativeMeetings: ObservableObject {
    @Published var visible = false
    @Published var title = "Meeting"
    @Published var phase = ""
    @Published var error: String?
    @Published private(set) var active = false
    @Published private(set) var admitted = false
    @Published private(set) var owner = false
    @Published private(set) var muted = false
    @Published private(set) var speaker = true
    @Published private(set) var cameraOn = false
    @Published private(set) var cameraBusy = false
    @Published private(set) var frontCamera = true
    @Published private(set) var localTrack: RTCVideoTrack?
    @Published private(set) var participants: [String: CallParticipant] = [:]
    @Published private(set) var waiting: [LobbyPerson] = []
    @Published var cameraError: String?
    var keepsConnection: Bool { active }

    private var token = UUID()
    private var live: LiveConnection?
    private var room: String?
    private var capabilities: Any?
    private var media: CallMedia?
    private var camera: CallCamera?
    private var mediaReady = false
    private var consuming = Set<String>()
    private var foreground = true

    func join(_ rawCode: String, fallbackTitle: String? = nil, live: LiveConnection, callActive: Bool = false) async {
        guard !visible, !callActive else {
            if callActive { error = "End the current call before joining a meeting."; visible = true }
            return
        }
        guard let code = MeetingCode.parse(rawCode) else { error = "Enter a valid meeting ID or link."; visible = true; return }
        self.live = live; title = fallbackTitle ?? "Meeting"; visible = true; active = true; admitted = false; phase = "Joining lobby…"; error = nil
        let generation = token
        do {
            let joined = try await live.request("meet:join", ["code": code])
            guard generation == token else { return }
            guard let roomID = joined["roomId"] as? String, let caps = joined["routerRtpCapabilities"] else { throw APIError(message: "Invalid meeting response.") }
            room = roomID; capabilities = caps; title = joined["title"] as? String ?? title; owner = joined["isOwner"] as? Bool ?? false
            let result = try await live.request("meet:request-join", ["roomId": roomID])
            guard generation == token else { return }
            if result["admitted"] as? Bool == true { try await enter(generation) }
            else { phase = "Waiting for the organizer to admit you…" }
        } catch { if generation == token { fail(error.localizedDescription) } }
    }

    func event(_ event: LiveEvent, live: LiveConnection) {
        guard active else { return }
        let eventRoom = event.payload["roomId"] as? String
        if let eventRoom, let room, eventRoom != room { return }
        switch event.name {
        case "meet:admitted":
            let generation = token
            Task { do { try await enter(generation) } catch { if generation == token { fail(error.localizedDescription) } } }
        case "meet:denied": fail("The organizer did not admit you to this meeting.")
        case "meet:lobby-waiting":
            guard owner, let peer = event.payload["peerId"] as? String, let user = event.payload["userId"] as? Int else { return }
            let person = LobbyPerson(peerID: peer, userID: user, name: event.payload["fullName"] as? String ?? "Participant")
            waiting.removeAll { $0.peerID == peer }; waiting.append(person)
        case "meet:lobby-left":
            if let peer = event.payload["peerId"] as? String { waiting.removeAll { $0.peerID == peer } }
        case "sfu:new-producer":
            guard mediaReady, let producer = event.payload["producerId"] as? String, let peer = event.payload["peerId"] as? String else { return }
            receive(producer, peer: peer, info: event.payload)
        case "sfu:producer-closed":
            if let producer = event.payload["producerId"] as? String { media?.remove(producer); consuming.remove(producer); participants.removeValue(forKey: producer) }
        case "sfu:peer-left":
            if let peer = event.payload["peerId"] as? String {
                for person in participants.values.filter({ $0.peerID == peer }) { media?.remove(person.id); consuming.remove(person.id); participants.removeValue(forKey: person.id) }
            }
        case "sfu:producer-paused":
            if let producer = event.payload["producerId"] as? String { participants[producer]?.paused = event.payload["paused"] as? Bool ?? false }
        default: break
        }
    }

    private func enter(_ generation: UUID) async throws {
        guard !admitted, generation == token, let room, let capabilities, let live else { return }
        guard await AVAudioApplication.requestRecordPermission() else { throw APIError(message: "Allow microphone access in iPhone Settings to join meetings.") }
        try configureAudio()
        phase = "Connecting audio…"; admitted = true
        let engine = CallMedia(signal: { [weak live] name, payload in
            guard let live else { throw APIError(message: "Meeting closed.") }
            return try await live.request(name, payload)
        }, failed: { [weak self] message in Task { @MainActor in if self?.token == generation { self?.fail(message) } } })
        media = engine
        try await engine.start(room: room, capabilities: capabilities)
        guard generation == token else { engine.close(); return }
        engine.mute(muted); try? engine.speaker(speaker); mediaReady = true; phase = "In meeting"
        let result = try await live.request("sfu:get-producers", ["roomId": room])
        for producer in result["producers"] as? [[String: Any]] ?? [] {
            if let id = producer["producerId"] as? String, let peer = producer["peerId"] as? String { receive(id, peer: peer, info: producer) }
        }
        if owner { await reloadLobby() }
    }

    private func configureAudio() throws {
        let audio = AVAudioSession.sharedInstance()
        try audio.setCategory(.playAndRecord, mode: .videoChat, options: [.allowBluetoothHFP, .defaultToSpeaker])
        try audio.setActive(true)
    }

    private func receive(_ producer: String, peer: String, info: [String: Any]) {
        guard !consuming.contains(producer), let media else { return }
        guard let kind = info["kind"] as? String, ["audio", "video"].contains(kind) else { return }
        participants[producer] = CallParticipant(id: producer, peerID: peer, name: info["fullName"] as? String ?? "Participant", source: info["source"] as? String ?? "camera", paused: info["paused"] as? Bool ?? false)
        consuming.insert(producer); let generation = token
        Task { do {
            let track = try await media.consume(producer, peerID: peer)
            if generation == token { participants[producer]?.track = track; phase = "In meeting" }
        } catch {
            if generation == token {
                if kind == "video" { participants.removeValue(forKey: producer); consuming.remove(producer); cameraError = "Unable to display a participant’s video. " + error.localizedDescription }
                else { fail(error.localizedDescription) }
            }
        } }
    }

    var videoParticipants: [CallParticipant] {
        let values = Array(participants.values)
        return values.filter { item in item.track != nil || !values.contains(where: { $0.peerID == item.peerID && $0.track != nil }) }.sorted { $0.id < $1.id }
    }

    func reloadLobby() async {
        guard owner, let live, let room else { return }
        do {
            let result = try await live.request("meet:lobby-list", ["roomId": room])
            waiting = (result["waiting"] as? [[String: Any]] ?? []).compactMap { row in
                guard let peer = row["peerId"] as? String, let user = row["userId"] as? Int else { return nil }
                return LobbyPerson(peerID: peer, userID: user, name: row["fullName"] as? String ?? "Participant")
            }
        } catch { self.error = error.localizedDescription }
    }

    func decide(_ person: LobbyPerson, admit: Bool) async {
        guard let live, let room else { return }
        do {
            _ = try await live.request(admit ? "meet:admit" : "meet:deny", ["roomId": room, "peerId": person.peerID])
            waiting.removeAll { $0.peerID == person.peerID }
        } catch { self.error = error.localizedDescription }
    }

    func toggleMute() { muted.toggle(); media?.mute(muted) }
    func toggleSpeaker() { do { try media?.speaker(!speaker); speaker.toggle() } catch { self.error = error.localizedDescription } }
    func toggleCamera() async {
        guard admitted, mediaReady, !cameraBusy, let media else { return }
        cameraBusy = true; cameraError = nil; let generation = token
        defer { if generation == token { cameraBusy = false } }
        if cameraOn {
            camera?.stop(); cameraOn = false; localTrack = nil
            do { try await media.pauseVideo(true) } catch { cameraError = error.localizedDescription }
            return
        }
        do {
            guard await AVCaptureDevice.requestAccess(for: .video) else { throw APIError(message: "Allow camera access in iPhone Settings. You can continue with audio.") }
            guard generation == token, foreground else { return }
            if camera == nil { camera = CallCamera() }
            guard let camera else { return }
            try await camera.start(front: frontCamera)
            guard generation == token, foreground else { camera.stop(); return }
            try await media.sendVideo(camera.track)
            guard generation == token else { camera.stop(); return }
            localTrack = camera.track; cameraOn = true
        } catch { if generation == token { camera?.stop(); cameraOn = false; localTrack = nil; cameraError = error.localizedDescription } }
    }
    func switchCamera() async {
        guard cameraOn, !cameraBusy, let camera else { return }
        let generation = token; cameraBusy = true; defer { if generation == token { cameraBusy = false } }
        camera.stop()
        do { try await camera.start(front: !frontCamera); guard generation == token, foreground else { camera.stop(); return }; frontCamera.toggle() }
        catch { if generation == token { camera.stop(); cameraOn = false; localTrack = nil; cameraError = error.localizedDescription; try? await media?.pauseVideo(true) } }
    }
    func setForeground(_ value: Bool) {
        foreground = value
        if !value { camera?.stop(); cameraOn = false; localTrack = nil; let engine = media; Task { try? await engine?.pauseVideo(true) } }
    }
    func leave() async {
        let connection = live
        clean(); visible = false
        try? await connection?.emit("meet:leave")
    }
    func closeError() { clean(); visible = false }
    func disconnected() { guard active else { return }; fail("The meeting ended because the connection was lost.", notifyServer: false) }
    private func fail(_ message: String, notifyServer: Bool = true) {
        let connection = live
        clean(preserveError: true); error = message; phase = "Unable to join"; visible = true
        if notifyServer { Task { try? await connection?.emit("meet:leave") } }
    }
    private func clean(preserveError: Bool = false) {
        camera?.stop(); camera = nil; cameraOn = false; cameraBusy = false; localTrack = nil; cameraError = nil
        participants.removeAll(); waiting.removeAll(); media?.close(); media = nil; mediaReady = false; consuming.removeAll()
        active = false; admitted = false; owner = false; room = nil; capabilities = nil; live = nil; muted = false; speaker = true; token = UUID()
        if !preserveError { error = nil }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

struct NativeMeetingView: View {
    @ObservedObject var meetings: NativeMeetings
    @State private var showLobby = false
    var body: some View {
        Group {
            if meetings.admitted { meetingStage }
            else { waitingRoom }
        }.interactiveDismissDisabled()
    }
    private var waitingRoom: some View {
        VStack(spacing: 18) {
            Spacer()
            Image(systemName: meetings.error == nil ? "person.2.wave.2" : "exclamationmark.triangle.fill").font(.system(size: 54)).foregroundStyle(meetings.error == nil ? .blue : .red)
            Text(meetings.title).font(.title2.bold()).multilineTextAlignment(.center)
            Text(meetings.phase).foregroundStyle(.secondary).multilineTextAlignment(.center)
            if let error = meetings.error { Text(error).foregroundStyle(.red).multilineTextAlignment(.center) }
            Spacer()
            Button(meetings.error == nil ? "Leave lobby" : "Close", role: .destructive) { Task { if meetings.error == nil { await meetings.leave() } else { meetings.closeError() } } }.novaGlassButtons(prominent: true).tint(.red)
        }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity).background(Color(.systemBackground))
    }
    private var meetingStage: some View {
        ZStack {
            videoGrid.ignoresSafeArea()
            VStack {
                HStack {
                    VStack(alignment: .leading, spacing: 2) { Text(meetings.title).font(.headline); Text(meetings.phase).font(.caption) }
                    Spacer()
                    if meetings.owner {
                        Button { showLobby = true; Task { await meetings.reloadLobby() } } label: {
                            Label("Lobby", systemImage: meetings.waiting.isEmpty ? "person.2" : "person.2.badge.gearshape")
                        }.badge(meetings.waiting.count)
                    }
                }.padding(10).novaGlass(in: RoundedRectangle(cornerRadius: 16)).padding(8)
                Spacer()
                if let message = meetings.cameraError { Text(message).font(.caption).foregroundStyle(.red).padding(8).background(.ultraThinMaterial, in: Capsule()) }
                HStack(spacing: 12) {
                    Button { meetings.toggleMute() } label: { Label(meetings.muted ? "Unmute" : "Mute", systemImage: meetings.muted ? "mic.slash.fill" : "mic.fill") }
                    Button { meetings.toggleSpeaker() } label: { Label("Speaker", systemImage: meetings.speaker ? "speaker.wave.3.fill" : "speaker.fill") }
                    Button { Task { await meetings.toggleCamera() } } label: { Label(meetings.cameraOn ? "Camera off" : "Camera on", systemImage: meetings.cameraOn ? "video.fill" : "video.slash") }.disabled(meetings.cameraBusy)
                    Button { Task { await meetings.switchCamera() } } label: { Image(systemName: "arrow.triangle.2.circlepath.camera") }.accessibilityLabel("Switch camera").disabled(!meetings.cameraOn || meetings.cameraBusy)
                    Button { Task { await meetings.leave() } } label: { Label("Leave", systemImage: "phone.down.fill") }.tint(.red)
                }.labelStyle(.iconOnly).novaGlassButtons().padding(10).novaGlass(in: Capsule()).padding(8)
            }
        }.sheet(isPresented: $showLobby) { MeetingLobbyView(meetings: meetings) }
    }
    @ViewBuilder private var videoGrid: some View {
        GeometryReader { geometry in
            let people = meetings.videoParticipants
            let count = max(1, people.count) + 1
            let columns = count <= 2 ? 1 : 2
            let rows = (count + columns - 1) / columns
            VStack(spacing: 2) {
                ForEach(0..<rows, id: \.self) { row in
                    HStack(spacing: 2) {
                        ForEach((row * columns)..<min(count, (row + 1) * columns), id: \.self) { index in
                            Group {
                                if index == count - 1 { tile(name: meetings.cameraOn ? "You" : "You · Camera off", track: meetings.localTrack, paused: !meetings.cameraOn, mirrored: meetings.frontCamera) }
                                else if people.isEmpty { tile(name: "Waiting for participants", track: nil, paused: true) }
                                else { let p = people[index]; tile(name: p.name + (p.source == "screen" ? " · Screen" : ""), track: p.track, paused: p.paused, screen: p.source == "screen") }
                            }.frame(width: geometry.size.width / CGFloat(columns), height: geometry.size.height / CGFloat(rows))
                        }
                    }
                }
            }.frame(width: geometry.size.width, height: geometry.size.height).background(.black)
        }
    }
    private func tile(name: String, track: RTCVideoTrack?, paused: Bool, mirrored: Bool = false, screen: Bool = false) -> some View {
        ZStack {
            Color.black
            if let track, !paused { CallVideoTile(track: track, mirrored: mirrored, fillsTile: !screen) }
            else { Image(systemName: "person.crop.circle.fill").font(.system(size: 52)).foregroundStyle(.white.opacity(0.8)) }
        }.clipped().overlay(alignment: .bottomLeading) { Text(name).font(.caption).foregroundStyle(.white).padding(6).background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 6)).padding(8).padding(.bottom, 76) }
    }
}

struct MeetingLobbyView: View {
    @ObservedObject var meetings: NativeMeetings
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                if meetings.waiting.isEmpty { ContentUnavailableView("Nobody is waiting", systemImage: "person.2") }
                ForEach(meetings.waiting) { person in
                    VStack(alignment: .leading, spacing: 10) {
                        Text(person.name).font(.headline)
                        HStack {
                            Button("Admit") { Task { await meetings.decide(person, admit: true) } }.novaGlassButtons(prominent: true)
                            Button("Deny", role: .destructive) { Task { await meetings.decide(person, admit: false) } }.novaGlassButtons()
                        }
                    }.padding(.vertical, 4)
                }
            }.navigationTitle("Meeting lobby").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }.presentationDetents([.medium, .large])
    }
}
