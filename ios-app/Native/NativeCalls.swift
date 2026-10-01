import SwiftUI
import AVFoundation

@MainActor final class NativeCalls: ObservableObject {
    @Published var visible = false
    @Published var title = "Audio call"
    @Published var phase = ""
    @Published var incoming = false
    @Published var muted = false
    @Published var speaker = false
    @Published var error: String?
    private var id: String?
    private var token = UUID()
    private var media: CallMedia?
    private var live: LiveConnection?
    private var room: String?
    private var consuming = Set<String>()
    private var mediaReady = false
    func start(conversationID: Int, title: String, live: LiveConnection) async {
        guard !visible else { return }
        self.live = live; self.title = title; visible = true; phase = "Starting…"; error = nil
        let generation = token
        do {
            guard await AVAudioApplication.requestRecordPermission() else { throw APIError(message: "Allow microphone access in iPhone Settings to make calls.") }
            guard generation == token else { return }
            let response = try await live.request("gcall:start", ["conversationId": conversationID, "mode": "audio"])
            guard let callID = response["id"] as? String else { throw APIError(message: "Invalid call response.") }
            guard generation == token else {
                _ = try? await live.request("gcall:join", ["id": callID])
                _ = try? await live.request("gcall:leave", ["id": callID]); return
            }
            id = callID; phase = "Calling…"; try await join(generation)
        } catch { if generation == token { await fail(error.localizedDescription) } }
    }
    func event(_ event: LiveEvent, live: LiveConnection) {
        if event.name == "gcall:incoming", !visible, event.payload["mode"] as? String == "audio" {
            self.live = live; id = event.payload["id"] as? String; title = event.payload["title"] as? String ?? "Incoming call"
            incoming = true; visible = true; phase = "Incoming audio call"; error = nil
        } else if event.name == "gcall:ended", event.payload["id"] as? String == id { clean(); visible = false }
        else if event.name == "sfu:new-producer", mediaReady, event.payload["kind"] as? String == "audio", let producer = event.payload["producerId"] as? String { receive(producer) }
        else if event.name == "gcall:state", let call = event.payload["call"] as? [String: Any], call["id"] as? String == id, !incoming {
            phase = (call["count"] as? Int ?? 0) >= 2 ? "Connecting audio…" : "Calling…"
        } else if event.name == "sfu:producer-closed", let producer = event.payload["producerId"] as? String {
            media?.remove(producer); consuming.remove(producer)
        }
        else if event.name == "gcall:ring-stop", event.payload["id"] as? String == id, incoming { clean(); visible = false }
    }
    func answer() async {
        let generation = token
        do {
            guard await AVAudioApplication.requestRecordPermission() else { throw APIError(message: "Microphone access is required. Enable it in Settings.") }
            guard generation == token else { return }
            incoming = false; phase = "Connecting…"; try await join(generation)
        } catch { if generation == token { await fail(error.localizedDescription) } }
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
        mediaReady = true
        let resultProducers = try await live.request("sfu:get-producers", ["roomId": roomID])
        for producer in resultProducers["producers"] as? [[String: Any]] ?? [] {
            if producer["kind"] as? String == "audio", let producerID = producer["producerId"] as? String { receive(producerID) }
        }
        if consuming.isEmpty { phase = "Calling…" }
    }
    private func receive(_ producer: String) {
        guard !consuming.contains(producer), let media else { return }
        consuming.insert(producer); let generation = token
        Task { do { try await media.consume(producer); if generation == token { phase = "Audio call" } } catch { if generation == token { await fail(error.localizedDescription) } } }
    }
    func toggleMute() { muted.toggle(); media?.mute(muted) }
    func toggleSpeaker() { do { try media?.speaker(!speaker); speaker.toggle() } catch { self.error = error.localizedDescription } }
    func hangUp() async {
        let oldID = id; let connection = live; let wasIncoming = incoming
        clean(); visible = false
        if let oldID { _ = try? await connection?.request(wasIncoming ? "gcall:decline" : "gcall:leave", ["id": oldID]) }
    }
    func disconnected() { guard visible else { return }; clean(); error = "The call ended because the connection was lost."; phase = "Call ended" }
    private func fail(_ message: String) async { await hangUp(); error = message; phase = "Unable to connect"; visible = true }
    private func clean() { token = UUID(); media?.close(); media = nil; id = nil; room = nil; mediaReady = false; consuming.removeAll(); incoming = false; muted = false; speaker = false }
}

struct NativeCallView: View {
    @ObservedObject var calls: NativeCalls
    var body: some View {
        VStack(spacing: 28) {
            Image(systemName: "phone.fill").font(.system(size: 48)).foregroundStyle(.blue)
            Text(calls.title).font(.title2.bold()).multilineTextAlignment(.center)
            Text(calls.phase).foregroundStyle(.secondary)
            if let error = calls.error { Text(error).foregroundStyle(.red).multilineTextAlignment(.center) }
            if calls.incoming { Button("Answer") { Task { await calls.answer() } }.buttonStyle(.borderedProminent) }
            else if calls.error == nil {
                HStack(spacing: 24) {
                    Button { calls.toggleMute() } label: { Label(calls.muted ? "Unmute" : "Mute", systemImage: calls.muted ? "mic.slash.fill" : "mic.fill") }
                    Button { calls.toggleSpeaker() } label: { Label("Speaker", systemImage: calls.speaker ? "speaker.wave.3.fill" : "speaker.fill") }.tint(calls.speaker ? .blue : .secondary)
                }.buttonStyle(.bordered)
            }
            Button(calls.error != nil ? "Close" : (calls.incoming ? "Decline" : "Hang up"), role: .destructive) { Task { await calls.hangUp() } }.buttonStyle(.borderedProminent).tint(.red)
        }.padding(28).frame(maxWidth: .infinity, maxHeight: .infinity).background(Color(.systemBackground)).interactiveDismissDisabled()
    }
}
