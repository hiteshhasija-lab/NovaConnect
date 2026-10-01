import Foundation
import AVFoundation
import Mediasoup
import WebRTC

// Native media work stays off the main actor: producing waits for a signaling callback.
final class CallMedia: NSObject, SendTransportDelegate, ReceiveTransportDelegate {
    let queue = DispatchQueue(label: "NovaConnect.call.media")
    let signal: (String, [String: Any]) async throws -> [String: Any]
    let failed: (String) -> Void
    private var device: Device?
    private let factory = RTCPeerConnectionFactory()
    private var send: SendTransport?
    private var receive: ReceiveTransport?
    private var producer: Producer?
    private var track: RTCAudioTrack?
    private var consumers: [String: Consumer] = [:]
    private var room = ""
    private var closed = false
    init(signal: @escaping (String, [String: Any]) async throws -> [String: Any], failed: @escaping (String) -> Void) {
        self.signal = signal; self.failed = failed
    }
    static func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self) }
    static func object(_ text: String) throws -> Any { try JSONSerialization.jsonObject(with: Data(text.utf8)) }
    func work<T>(_ block: @escaping () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in queue.async { continuation.resume(with: Result { try block() }) } }
    }
    func start(room: String, capabilities: Any) async throws {
        self.room = room
        let outgoing = try await signal("sfu:create-transport", ["roomId": room, "direction": "send"])
        let incoming = try await signal("sfu:create-transport", ["roomId": room, "direction": "recv"])
        guard let sendID = outgoing["id"] as? String, let sendICE = outgoing["iceParameters"], let sendCandidates = outgoing["iceCandidates"], let sendDTLS = outgoing["dtlsParameters"],
              let recvID = incoming["id"] as? String, let recvICE = incoming["iceParameters"], let recvCandidates = incoming["iceCandidates"], let recvDTLS = incoming["dtlsParameters"] else { throw APIError(message: "Invalid audio transport response.") }
        try await work {
            guard !self.closed else { throw APIError(message: "Call closed.") }
            let audio = AVAudioSession.sharedInstance()
            try audio.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth])
            try audio.setActive(true)
            let device = Device(pcFactory: self.factory); self.device = device
            try device.load(with: Self.json(capabilities))
            guard try device.canProduce(.audio) else { throw APIError(message: "Audio is not supported by this call server.") }
            self.send = try device.createSendTransport(id: sendID, iceParameters: Self.json(sendICE), iceCandidates: Self.json(sendCandidates), dtlsParameters: Self.json(sendDTLS), sctpParameters: nil, appData: nil)
            self.receive = try device.createReceiveTransport(id: recvID, iceParameters: Self.json(recvICE), iceCandidates: Self.json(recvCandidates), dtlsParameters: Self.json(recvDTLS))
            self.send?.delegate = self; self.receive?.delegate = self
            let source = self.factory.audioSource(with: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil))
            let track = self.factory.audioTrack(with: source, trackId: UUID().uuidString); self.track = track
            self.producer = try self.send?.createProducer(for: track, encodings: nil, codecOptions: nil, codec: nil, appData: "{}")
        }
    }
    func consume(_ producerID: String) async throws {
        let info: (String, Any)? = try await work {
            guard self.consumers[producerID] == nil, let receive = self.receive, let device = self.device else { return nil }
            return (receive.id, try Self.object(device.rtpCapabilities()))
        }
        guard let info else { return }
        let result = try await signal("sfu:consume", ["roomId": room, "transportId": info.0, "producerId": producerID, "rtpCapabilities": info.1])
        guard result["kind"] as? String == "audio", let id = result["id"] as? String, let rtp = result["rtpParameters"] else { return }
        try await work {
            guard let receive = self.receive else { return }
            self.consumers[producerID] = try receive.consume(consumerId: id, producerId: producerID, kind: .audio, rtpParameters: Self.json(rtp), appData: nil)
        }
        _ = try await signal("sfu:resume-consumer", ["roomId": room, "consumerId": id])
    }
    func remove(_ id: String) { queue.async { self.consumers.removeValue(forKey: id)?.close() } }
    func mute(_ muted: Bool) { queue.async { self.track?.isEnabled = !muted } }
    func speaker(_ enabled: Bool) throws { try AVAudioSession.sharedInstance().overrideOutputAudioPort(enabled ? .speaker : .none) }
    func close() { queue.async {
        self.closed = true
        self.track?.isEnabled = false; self.producer?.close(); self.producer = nil
        self.consumers.values.forEach { $0.close() }; self.consumers.removeAll()
        self.send?.close(); self.receive?.close(); self.send = nil; self.receive = nil; self.track = nil; self.device = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    } }
    func onConnect(transport: Transport, dtlsParameters: String) {
        Task { do { _ = try await signal("sfu:connect-transport", ["roomId": room, "transportId": transport.id, "dtlsParameters": Self.object(dtlsParameters)]) } catch { failed(error.localizedDescription) } }
    }
    func onConnectionStateChange(transport: Transport, connectionState: TransportConnectionState) {
        if connectionState == .failed { failed("The audio connection failed.") }
    }
    func onProduce(transport: Transport, kind: MediaKind, rtpParameters: String, appData: String, callback: @escaping (String?) -> Void) {
        Task { do {
            let result = try await signal("sfu:produce", ["roomId": room, "transportId": transport.id, "kind": "audio", "rtpParameters": Self.object(rtpParameters), "appData": [:]])
            callback(result["producerId"] as? String)
        } catch { callback(nil); failed(error.localizedDescription) } }
    }
    func onProduceData(transport: Transport, sctpParameters: String, label: String, protocol dataProtocol: String, appData: String, callback: @escaping (String?) -> Void) { callback(nil) }
}
