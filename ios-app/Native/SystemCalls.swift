import AVFoundation
import CallKit
import WebRTC

// Kept separate from signaling so system actions can be tested without placing calls.
@MainActor protocol SystemCalling: AnyObject {
    var answer: (() async -> Bool)? { get set }
    var end: (() async -> Void)? { get set }
    var mute: ((Bool) -> Void)? { get set }
    var reset: (() -> Void)? { get set }
    func outgoing(title: String, video: Bool) async throws
    func incoming(title: String, video: Bool) async throws
    func requestAnswer() async throws
    func requestEnd() async throws
    func requestMute(_ muted: Bool) async throws
    func connected()
    func finish(failed: Bool)
}

@MainActor final class SystemCalls: NSObject, SystemCalling, @preconcurrency CXProviderDelegate {
    var answer: (() async -> Bool)?
    var end: (() async -> Void)?
    var mute: ((Bool) -> Void)?
    var reset: (() -> Void)?
    private let provider: CXProvider
    private let controller = CXCallController()
    private var uuid: UUID?
    private var outgoingCall = false
    private var reportedConnected = false

    override init() {
        let config = CXProviderConfiguration()
        config.supportsVideo = true
        config.maximumCallGroups = 1
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.generic]
        config.includesCallsInRecents = false
        provider = CXProvider(configuration: config)
        super.init()
        provider.setDelegate(self, queue: .main)
        RTCAudioSession.sharedInstance().useManualAudio = true
        RTCAudioSession.sharedInstance().isAudioEnabled = false
    }
    private func update(_ title: String, video: Bool) -> CXCallUpdate {
        let value = CXCallUpdate()
        value.remoteHandle = CXHandle(type: .generic, value: title)
        value.localizedCallerName = title
        value.supportsHolding = false; value.supportsGrouping = false
        value.supportsUngrouping = false; value.supportsDTMF = false
        value.hasVideo = video
        return value
    }
    func outgoing(title: String, video: Bool) async throws {
        let id = UUID(); uuid = id; outgoingCall = true; reportedConnected = false
        do {
            let action = CXStartCallAction(call: id, handle: CXHandle(type: .generic, value: title))
            action.isVideo = video
            try await controller.request(CXTransaction(action: action))
            guard uuid == id else { throw CancellationError() }
            provider.reportCall(with: id, updated: update(title, video: video))
        } catch { if uuid == id { finish(failed: true) }; throw error }
    }
    func incoming(title: String, video: Bool) async throws {
        let id = UUID(); uuid = id; outgoingCall = false; reportedConnected = false
        do {
            try await provider.reportNewIncomingCall(with: id, update: update(title, video: video))
            // A remote hang-up can arrive while CallKit is still reporting the call.
            guard uuid == id else {
                provider.reportCall(with: id, endedAt: Date(), reason: .remoteEnded)
                throw CancellationError()
            }
        } catch { if uuid == id { finish(failed: true) }; throw error }
    }
    func requestAnswer() async throws {
        guard let uuid else { throw CancellationError() }
        try await controller.request(CXTransaction(action: CXAnswerCallAction(call: uuid)))
    }
    func requestEnd() async throws {
        guard let uuid else { throw CancellationError() }
        try await controller.request(CXTransaction(action: CXEndCallAction(call: uuid)))
    }
    func requestMute(_ muted: Bool) async throws {
        guard let uuid else { throw CancellationError() }
        try await controller.request(CXTransaction(action: CXSetMutedCallAction(call: uuid, muted: muted)))
    }
    func connected() {
        guard outgoingCall, !reportedConnected, let uuid else { return }
        reportedConnected = true
        provider.reportOutgoingCall(with: uuid, connectedAt: Date())
    }
    func finish(failed: Bool) {
        guard let id = uuid else { return }
        uuid = nil
        provider.reportCall(with: id, endedAt: Date(), reason: failed ? .failed : .remoteEnded)
    }
    private func configureAudio() throws {
        // CallKit activates the session after start/answer is fulfilled.
        try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP])
    }
    func providerDidReset(_ provider: CXProvider) {
        uuid = nil
        RTCAudioSession.sharedInstance().isAudioEnabled = false
        reset?()
    }
    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        guard action.callUUID == uuid else { action.fail(); return }
        do {
            try configureAudio()
            provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
            action.fulfill()
        } catch { action.fail(); reset?() }
    }
    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        guard action.callUUID == uuid else { action.fail(); return }
        Task {
            do {
                try configureAudio()
                let accepted = await answer?() ?? false
                guard action.callUUID == uuid, accepted else { action.fail(); return }
                action.fulfill()
            } catch { action.fail(); reset?() }
        }
    }
    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        guard action.callUUID == uuid else { action.fail(); return }
        uuid = nil
        action.fulfill()
        Task { await end?() }
    }
    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        guard action.callUUID == uuid else { action.fail(); return }
        mute?(action.isMuted); action.fulfill()
    }
    func provider(_ provider: CXProvider, timedOutPerforming action: CXAction) {
        action.fail(); reset?()
    }
    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        RTCAudioSession.sharedInstance().audioSessionDidActivate(audioSession)
        RTCAudioSession.sharedInstance().isAudioEnabled = true
    }
    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        RTCAudioSession.sharedInstance().isAudioEnabled = false
        RTCAudioSession.sharedInstance().audioSessionDidDeactivate(audioSession)
    }
}
