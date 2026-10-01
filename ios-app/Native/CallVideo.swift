import SwiftUI
import AVFoundation
import WebRTC

struct CallParticipant: Identifiable {
    let id: String
    let peerID: String
    let name: String
    let source: String
    var track: RTCVideoTrack?
    var paused: Bool
}

@MainActor final class CallCamera {
    private let factory = RTCPeerConnectionFactory()
    private let source: RTCVideoSource
    let track: RTCVideoTrack
    private let capturer: RTCCameraVideoCapturer
    private var revision = UUID()
    init() {
        source = factory.videoSource()
        track = factory.videoTrack(with: source, trackId: UUID().uuidString)
        capturer = RTCCameraVideoCapturer(delegate: source)
        track.isEnabled = false
    }
    func start(front: Bool) async throws {
        let token = UUID(); revision = token
        guard let device = RTCCameraVideoCapturer.captureDevices().first(where: { $0.position == (front ? .front : .back) }),
              let format = RTCCameraVideoCapturer.supportedFormats(for: device).min(by: {
                  let a = CMVideoFormatDescriptionGetDimensions($0.formatDescription)
                  let b = CMVideoFormatDescriptionGetDimensions($1.formatDescription)
                  return abs(Int(a.width) - 640) + abs(Int(a.height) - 480) < abs(Int(b.width) - 640) + abs(Int(b.height) - 480)
              }) else { throw APIError(message: "This camera is unavailable.") }
        let fps = min(30, Int(format.videoSupportedFrameRateRanges.map(\.maxFrameRate).max() ?? 30))
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            capturer.startCapture(with: device, format: format, fps: fps) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
        guard revision == token else { throw CancellationError() }
        track.isEnabled = true
    }
    func stop() {
        revision = UUID(); track.isEnabled = false
        capturer.stopCapture()
    }
}

struct CallVideoTile: UIViewRepresentable {
    let track: RTCVideoTrack
    var mirrored = false
    final class Coordinator {
        var track: RTCVideoTrack?
    }
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> RTCMTLVideoView {
        let view = RTCMTLVideoView(frame: .zero)
        view.videoContentMode = .scaleAspectFit
        view.backgroundColor = .black
        return view
    }
    func updateUIView(_ view: RTCMTLVideoView, context: Context) {
        if context.coordinator.track !== track {
            context.coordinator.track?.remove(view)
            track.add(view); context.coordinator.track = track
        }
        view.transform = mirrored ? CGAffineTransform(scaleX: -1, y: 1) : .identity
    }
    static func dismantleUIView(_ view: RTCMTLVideoView, coordinator: Coordinator) {
        coordinator.track?.remove(view); coordinator.track = nil
    }
}
