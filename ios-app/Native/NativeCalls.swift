import SwiftUI
import AVFoundation
import WebRTC

@MainActor final class NativeCalls: ObservableObject {
    @Published var visible = false
    @Published var title = "Audio call"
    @Published var phase = ""
    @Published var incoming = false
    @Published var muted = false
    @Published var speaker = false
    @Published var error: String?
    @Published private(set) var active = false
    @Published private(set) var pendingEndRequests = 0
    var keepsConnection: Bool { active || pendingEndRequests > 0 }
    @Published private(set) var video = false
    @Published private(set) var cameraOn = false
    @Published private(set) var cameraBusy = false
    @Published private(set) var frontCamera = true
    @Published private(set) var localTrack: RTCVideoTrack?
    @Published private(set) var participants: [String: CallParticipant] = [:]
    @Published var cameraError: String?
    private var camera: CallCamera?
    private var foreground = true
    private let system: SystemCalling
    init(system: SystemCalling? = nil) {
        self.system = system ?? SystemCalls()
        self.system.answer = { [weak self] in await self?.performAnswer() ?? false }
        self.system.end = { [weak self] in await self?.endCall() }
        self.system.mute = { [weak self] value in self?.muted = value; self?.media?.mute(value) }
        self.system.reset = { [weak self] in Task { if self?.active == true { await self?.fail("The system ended the call.") } } }
    }
    private var id: String?
    private var token = UUID()
    private var media: CallMedia?
    private var live: LiveConnection?
    private var room: String?
    private var consuming = Set<String>()
    private var mediaReady = false
    func start(conversationID: Int, title: String, live: LiveConnection, video: Bool = false) async {
        guard !visible else { return }
        self.video = video; self.live = live; self.title = title; visible = true; active = true; phase = "Starting…"; error = nil
        let generation = token
        do {
            guard await AVAudioApplication.requestRecordPermission() else { throw APIError(message: "Allow microphone access in iPhone Settings to make calls.") }
            guard generation == token else { return }
            try await system.outgoing(title: title, video: video)
            guard generation == token else { return }
            let response = try await live.request("gcall:start", ["conversationId": conversationID, "mode": video ? "video" : "audio"])
            guard let callID = response["id"] as? String else { throw APIError(message: "Invalid call response.") }
            guard generation == token else {
                _ = try? await live.request("gcall:join", ["id": callID])
                _ = try? await live.request("gcall:leave", ["id": callID]); return
            }
            id = callID; self.video = response["mode"] as? String == "video"; phase = "Calling…"; try await join(generation)
            if generation == token, self.video { await toggleCamera() }
        } catch { if generation == token { await fail(error.localizedDescription) } }
    }
    func event(_ event: LiveEvent, live: LiveConnection) {
        if event.name == "gcall:incoming", !visible, let mode = event.payload["mode"] as? String, ["audio", "video"].contains(mode), let callID = event.payload["id"] as? String, !callID.isEmpty {
            video = mode == "video"; self.live = live; id = callID; title = event.payload["title"] as? String ?? "Incoming call"
            incoming = true; visible = true; active = true; phase = video ? "Incoming video call" : "Incoming audio call"; error = nil
            let generation = token
            Task {
                guard generation == token else { return }
                do { try await system.incoming(title: title, video: video) }
                catch { if generation == token { await fail("Unable to display the incoming call: " + error.localizedDescription) } }
            }
        } else if event.name == "gcall:ended", event.payload["id"] as? String == id { clean(); visible = false }
        else if event.name == "sfu:new-producer", mediaReady, let producer = event.payload["producerId"] as? String, let peer = event.payload["peerId"] as? String { receive(producer, peer: peer, info: event.payload) }
        else if event.name == "gcall:state", let call = event.payload["call"] as? [String: Any], call["id"] as? String == id, !incoming {
            phase = !consuming.isEmpty ? (video ? "Video call" : "Audio call") : ((call["count"] as? Int ?? 0) >= 2 ? "Connecting audio…" : "Calling…")
        } else if event.name == "sfu:producer-closed", let producer = event.payload["producerId"] as? String {
            media?.remove(producer); consuming.remove(producer); participants.removeValue(forKey: producer)
        }
        else if event.name == "sfu:peer-left", let peer = event.payload["peerId"] as? String {
            for person in participants.values.filter({ $0.peerID == peer }) {
                media?.remove(person.id); consuming.remove(person.id); participants.removeValue(forKey: person.id)
            }
        }
        else if event.name == "sfu:producer-paused", let producer = event.payload["producerId"] as? String {
            participants[producer]?.paused = event.payload["paused"] as? Bool ?? false
        }
        else if event.name == "gcall:ring-stop", event.payload["id"] as? String == id, incoming { clean(); visible = false }
    }
    func answer() async {
        do { try await system.requestAnswer() }
        catch { if active { await fail(error.localizedDescription) } }
    }
    private func performAnswer() async -> Bool {
        guard active, incoming else { return false }
        let generation = token
        do {
            guard await AVAudioApplication.requestRecordPermission() else { throw APIError(message: "Microphone access is required. Enable it in Settings.") }
            guard generation == token else { return false }
            incoming = false; phase = "Connecting…"; try await join(generation)
            return generation == token
        } catch { if generation == token { await fail(error.localizedDescription) }; return false }
    }
    private func join(_ generation: UUID) async throws {
        guard let id, let live else { return }
        let result = try await live.request("gcall:join", ["id": id])
        guard generation == token else { return }
        guard let roomID = result["roomId"] as? String, let capabilities = result["routerRtpCapabilities"] else { throw APIError(message: "Invalid call media response.") }
        room = roomID
        let engine = CallMedia(signal: { [weak live] name, payload in
            guard let live else { throw APIError(message: "Call closed.") }
            return try await live.request(name, payload)
        }, failed: { [weak self] message in Task { @MainActor in if self?.token == generation { await self?.fail(message) } } })
        media = engine
        try await engine.start(room: roomID, capabilities: capabilities)
        guard generation == token else { engine.close(); return }
        engine.mute(muted)
        mediaReady = true
        let resultProducers = try await live.request("sfu:get-producers", ["roomId": roomID])
        for producer in resultProducers["producers"] as? [[String: Any]] ?? [] {
            if let producerID = producer["producerId"] as? String, let peer = producer["peerId"] as? String { receive(producerID, peer: peer, info: producer) }
        }
        if consuming.isEmpty { phase = "Calling…" }
    }
    private func receive(_ producer: String, peer: String, info: [String: Any]) {
        guard !consuming.contains(producer), let media else { return }
        guard let kind = info["kind"] as? String, ["audio", "video"].contains(kind) else { return }
        participants[producer] = CallParticipant(id: producer, peerID: peer, name: info["fullName"] as? String ?? "Participant", source: info["source"] as? String ?? "camera", paused: info["paused"] as? Bool ?? false)
        consuming.insert(producer); let generation = token
        Task { do { let track = try await media.consume(producer, peerID: peer); if generation == token { participants[producer]?.track = track; phase = video ? "Video call" : "Audio call"; system.connected() } } catch { if generation == token {
            if kind == "video" { participants.removeValue(forKey: producer); consuming.remove(producer); cameraError = "Unable to display a participant’s video. " + error.localizedDescription }
            else { await fail(error.localizedDescription) }
        } } }
    }
    var videoParticipants: [CallParticipant] {
        let values = Array(participants.values)
        return values.filter { item in
            item.track != nil || !values.contains(where: { $0.peerID == item.peerID && $0.track != nil })
        }.sorted { $0.id < $1.id }
    }
    func toggleCamera() async {
        guard active, mediaReady, !cameraBusy, let media else { return }
        cameraBusy = true; cameraError = nil
        let generation = token
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
            guard generation == token, foreground else { camera.stop(); try? await media.pauseVideo(true); return }
            localTrack = camera.track; cameraOn = true
        } catch {
            if generation == token { camera?.stop(); cameraOn = false; localTrack = nil; cameraError = error.localizedDescription }
        }
    }
    func switchCamera() async {
        guard cameraOn, !cameraBusy, let camera else { return }
        let generation = token; cameraBusy = true
        defer { if generation == token { cameraBusy = false } }
        camera.stop()
        do {
            try await camera.start(front: !frontCamera)
            guard generation == token, foreground else { camera.stop(); return }
            frontCamera.toggle()
        } catch {
            if generation == token { camera.stop(); cameraOn = false; localTrack = nil; cameraError = error.localizedDescription; try? await media?.pauseVideo(true) }
        }
    }
    func setForeground(_ value: Bool) {
        foreground = value
        if !value {
            camera?.stop(); cameraOn = false; localTrack = nil
            let engine = media
            Task { try? await engine?.pauseVideo(true) }
        }
    }
    func toggleMute() {
        Task { do { try await system.requestMute(!muted) } catch { self.error = error.localizedDescription } }
    }
    func toggleSpeaker() { do { try media?.speaker(!speaker); speaker.toggle() } catch { self.error = error.localizedDescription } }
    func hangUp() async {
        guard active else { visible = false; error = nil; return }
        do { try await system.requestEnd() }
        catch { await endCall() }
    }
    private func endCall() async {
        let oldID = id; let connection = live; let wasIncoming = incoming
        if oldID != nil { pendingEndRequests += 1 }
        clean(); visible = false
        if let oldID {
            Task {
                _ = try? await connection?.request(wasIncoming ? "gcall:decline" : "gcall:leave", ["id": oldID])
                pendingEndRequests -= 1
            }
        }
    }
    func disconnected() { guard active else { return }; system.finish(failed: true); clean(); error = "The call ended because the connection was lost."; phase = "Call ended" }
    private func fail(_ message: String) async { system.finish(failed: true); await endCall(); error = message; phase = "Unable to connect"; visible = true }
    private func clean() { camera?.stop(); camera = nil; cameraOn = false; cameraBusy = false; localTrack = nil; cameraError = nil; participants.removeAll(); system.finish(failed: false); active = false; token = UUID(); media?.close(); media = nil; id = nil; room = nil; mediaReady = false; consuming.removeAll(); incoming = false; muted = false; speaker = false }
}

struct NativeCallView: View {
    @ObservedObject var calls: NativeCalls
    var body: some View {
        Group {
            if calls.video, !calls.incoming, calls.error == nil {
                videoGrid.ignoresSafeArea()
                    .overlay(alignment: .top) {
                        VStack(spacing: 2) {
                            Text(calls.title).font(.headline).lineLimit(2)
                            Text(calls.phase).font(.caption)
                            if let message = calls.cameraError { Text(message).font(.caption).foregroundStyle(.red) }
                        }.padding(10).novaGlass(in: RoundedRectangle(cornerRadius: 16)).padding(8)
                    }
                    .overlay(alignment: .bottom) {
                        HStack(spacing: 12) {
                            audioControls
                            cameraControls
                            Button { Task { await calls.hangUp() } } label: {
                                Label("Hang up", systemImage: "phone.down.fill")
                            }.tint(.red)
                        }.labelStyle(.iconOnly).novaGlassButtons()
                            .padding(10).novaGlass(in: Capsule()).padding(8)
                    }
            } else { standardCall }
        }.interactiveDismissDisabled()
    }
    private var standardCall: some View {
        VStack(spacing: 16) {
            Text(calls.title).font(.title2.bold()).multilineTextAlignment(.center)
            Text(calls.phase).foregroundStyle(.secondary)
            if let error = calls.error { Text(error).foregroundStyle(.red).multilineTextAlignment(.center) }
            Spacer()
            Image(systemName: calls.video ? "video.fill" : "phone.fill").font(.system(size: 48)).foregroundStyle(.blue)
            Spacer()
            if calls.incoming {
                if calls.video { Text("Your camera stays off until you turn it on.").font(.footnote).foregroundStyle(.secondary) }
                Button("Answer") { Task { await calls.answer() } }.novaGlassButtons(prominent: true)
            } else if calls.error == nil {
                ViewThatFits(in: .horizontal) {
                    HStack { audioControls; cameraControls }
                    VStack { HStack { audioControls }; HStack { cameraControls } }
                }.novaGlassButtons()
            }
            Button(calls.error != nil ? "Close" : (calls.incoming ? "Decline" : "Hang up"), role: .destructive) { Task { await calls.hangUp() } }.novaGlassButtons(prominent: true).tint(.red)
        }.padding(20).frame(maxWidth: .infinity, maxHeight: .infinity).background(Color(.systemBackground)).interactiveDismissDisabled()
    }
    @ViewBuilder private var audioControls: some View {
        Button { calls.toggleMute() } label: { Label(calls.muted ? "Unmute" : "Mute", systemImage: calls.muted ? "mic.slash.fill" : "mic.fill") }
        Button { calls.toggleSpeaker() } label: { Label("Speaker", systemImage: calls.speaker ? "speaker.wave.3.fill" : "speaker.fill") }.tint(calls.speaker ? .blue : .secondary)
    }
    @ViewBuilder private var cameraControls: some View {
        if calls.video {
            Button { Task { await calls.toggleCamera() } } label: { Label(calls.cameraOn ? "Camera off" : "Camera on", systemImage: calls.cameraOn ? "video.fill" : "video.slash") }.disabled(calls.cameraBusy)
            Button { Task { await calls.switchCamera() } } label: { Image(systemName: "arrow.triangle.2.circlepath.camera") }.accessibilityLabel("Switch camera").disabled(!calls.cameraOn || calls.cameraBusy)
        }
    }
    @ViewBuilder private var videoGrid: some View {
        if calls.videoParticipants.count <= 1 {
            GeometryReader { geometry in
                ZStack(alignment: .bottomTrailing) {
                    if let person = calls.videoParticipants.first {
                        tile(name: person.name, track: person.track, paused: person.paused, screen: person.source == "screen")
                    } else {
                        tile(name: "Waiting for participants", track: nil, paused: true)
                    }
                    tile(name: calls.cameraOn ? "You" : "You · Camera off", track: calls.localTrack, paused: !calls.cameraOn, mirrored: calls.frontCamera, labelInset: 6)
                        .frame(width: min(140, geometry.size.width * 0.29), height: min(190, geometry.size.height * 0.28))
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                        .overlay(RoundedRectangle(cornerRadius: 16).stroke(.white.opacity(0.5), lineWidth: 1))
                        .shadow(radius: 8)
                        .padding(.trailing, max(12, geometry.safeAreaInsets.trailing))
                        .padding(.bottom, geometry.safeAreaInsets.bottom + 88)
                }.frame(width: geometry.size.width, height: geometry.size.height)
            }
        } else { participantGrid }
    }
    private var participantGrid: some View {
        GeometryReader { geometry in
            let count = max(1, calls.videoParticipants.count) + 1
            let columns = count == 2 ? 2 : max(2, Int(ceil(sqrt(Double(count) * Double(geometry.size.width / max(1, geometry.size.height))))))
            let rows = (count + columns - 1) / columns
            VStack(spacing: 2) {
                ForEach(0..<rows, id: \.self) { row in
                    HStack(spacing: 2) {
                        ForEach((row * columns)..<min(count, (row + 1) * columns), id: \.self) { index in
                            Group {
                            if index == count - 1 {
                                tile(name: calls.cameraOn ? "You" : "You · Camera off", track: calls.localTrack, paused: !calls.cameraOn, mirrored: calls.frontCamera)
                            } else if calls.videoParticipants.isEmpty {
                                tile(name: "Waiting for participants", track: nil, paused: true)
                            } else {
                                let person = calls.videoParticipants[index]
                                tile(name: person.name + (person.source == "screen" ? " · Screen" : ""), track: person.track, paused: person.paused, screen: person.source == "screen")
                            }
                            }.frame(width: max(1, (geometry.size.width - CGFloat(min(columns, count - row * columns) - 1) * 2) / CGFloat(min(columns, count - row * columns))), height: max(1, (geometry.size.height - CGFloat(rows - 1) * 2) / CGFloat(rows)))
                        }
                    }.frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }.frame(width: geometry.size.width, height: geometry.size.height).background(.black)
        }
    }
    private func tile(name: String, track: RTCVideoTrack?, paused: Bool, mirrored: Bool = false, screen: Bool = false, labelInset: CGFloat = 88) -> some View {
        ZStack {
            Color.black
            if let track, !paused { CallVideoTile(track: track, mirrored: mirrored, fillsTile: !screen) }
            else { Image(systemName: "person.crop.circle.fill").font(.system(size: 48)).foregroundStyle(.white.opacity(0.8)) }
        }.frame(maxWidth: .infinity, maxHeight: .infinity).clipped()
            .overlay(alignment: .bottomLeading) {
                Text(name).font(.caption).lineLimit(2).foregroundStyle(.white)
                    .padding(6).background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 6))
                    .padding(.horizontal, 8).padding(.bottom, labelInset)
            }
            .accessibilityElement(children: .combine)
    }
}
