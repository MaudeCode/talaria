import AVFoundation
import Foundation
import Observation

/// Coordinates "one clip at a time": when a player starts, it asks the center
/// to pause whichever player was previously active.
@MainActor
final class AudioAttachmentPlaybackCenter {
    static let shared = AudioAttachmentPlaybackCenter()

    private weak var active: InlineAudioPlayerModel?

    private init() {}

    func playbackWillBegin(for model: InlineAudioPlayerModel) {
        if let active, active !== model {
            active.pauseForExternalRequest()
        }
        active = model
    }
}

/// Tracks whether the composer is actively capturing microphone audio for voice
/// dictation. The inline player consults this before commandeering the shared
/// `AVAudioSession`: switching it to `.playback` mid-capture would tear down the
/// live recording engine and silently interrupt dictation.
@MainActor
final class ComposerAudioCaptureState {
    static let shared = ComposerAudioCaptureState()

    private(set) var isCapturing = false

    private init() {}

    func setCapturing(_ capturing: Bool) {
        isCapturing = capturing
    }
}

/// Drives a single `AVAudioPlayer`: lazy load, play/pause, a 0.2s progress
/// ticker, and scrubbing. Owned by `InlineAudioPlayerView` via `@State`.
@MainActor
@Observable
public final class InlineAudioPlayerModel {
    public enum Phase: Equatable {
        case idle
        case loading
        case ready
        case failed
    }

    public private(set) var phase: Phase = .idle

    public init() {}
    public private(set) var isPlaying = false
    private(set) var currentTime: Double = 0
    public private(set) var duration: Double = 0
    private var scrubTime: Double?

    /// The position shown by the scrubber/label: the dragged value while the
    /// user is scrubbing, otherwise the live playback time.
    public var displayTime: Double { scrubTime ?? currentTime }

    @ObservationIgnored private var player: AVAudioPlayer?
    @ObservationIgnored private let delegateProxy = AudioPlayerDelegateProxy()
    @ObservationIgnored private var ticker: Timer?
    @ObservationIgnored private var didLoad = false

    public func loadIfNeeded(using load: () async -> Data?) async {
        guard !didLoad else { return }
        didLoad = true
        phase = .loading

        let data = await load()

        // A cancelled `.task` (e.g. the row scrolled off-screen mid-load) surfaces
        // as a `nil` result here. Don't treat that as a real failure: reset so the
        // player can load again if the view reappears, instead of being stuck on
        // the error state forever.
        if Task.isCancelled {
            didLoad = false
            phase = .idle
            return
        }

        guard let data else {
            phase = .failed
            return
        }
        configurePlayer(with: data)
    }

    private func configurePlayer(with data: Data) {
        do {
            let player = try AVAudioPlayer(data: data)
            delegateProxy.onFinish = { [weak self] in
                Task { @MainActor in self?.handlePlaybackFinished() }
            }
            delegateProxy.onDecodeError = { [weak self] in
                Task { @MainActor in self?.handleDecodeError() }
            }
            player.delegate = delegateProxy
            player.prepareToPlay()
            self.player = player
            duration = player.duration
            phase = .ready
        } catch {
            phase = .failed
        }
    }

    public func togglePlayPause() {
        guard phase == .ready, let player else { return }
        if isPlaying {
            pause()
        } else {
            AudioAttachmentPlaybackCenter.shared.playbackWillBegin(for: self)
            activateSession()
            if player.play() {
                isPlaying = true
                startTicker()
            }
        }
    }

    private func pause() {
        player?.pause()
        isPlaying = false
        stopTicker()
        // Release the shared session on manual pause too, so an audio app we
        // interrupted (Spotify, Podcasts, …) is told it can resume instead of
        // staying blocked until the view disappears. If another clip takes over,
        // its `activateSession()` immediately reclaims the session.
        deactivateSession()
    }

    /// Invoked by the playback center when another clip takes over.
    func pauseForExternalRequest() {
        pause()
    }

    public func scrub(to time: Double) {
        scrubTime = time
    }

    public func setScrubbing(_ scrubbing: Bool) {
        if scrubbing {
            scrubTime = currentTime
        } else if let target = scrubTime {
            player?.currentTime = target
            currentTime = target
            scrubTime = nil
        }
    }

    /// Stops playback and releases the run-loop ticker. Called on disappear.
    public func teardown() {
        pause()
        player?.currentTime = 0
        currentTime = 0
        deactivateSession()
    }

    private func handlePlaybackFinished() {
        isPlaying = false
        stopTicker()
        currentTime = 0
        player?.currentTime = 0
        deactivateSession()
    }

    /// A file can pass the `AVAudioPlayer(data:)` initializer but still fail to
    /// decode once playback actually starts. Surface that as a failure instead of
    /// leaving a live-looking play button that does nothing when tapped.
    private func handleDecodeError() {
        isPlaying = false
        stopTicker()
        deactivateSession()
        phase = .failed
    }

    private func activateSession() {
        // If composer dictation is currently capturing the mic, leave the shared
        // session alone: switching it to `.playback` would tear down the live
        // recording engine. `.playAndRecord` already supports playback, so the
        // clip still plays through the active session.
        guard !ComposerAudioCaptureState.shared.isCapturing else { return }

        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default)
        try? session.setActive(true)
        #endif
    }

    /// Releases the shared session once playback ends or the view disappears, so
    /// any audio app we interrupted on `activateSession()` is told it can resume
    /// (`.notifyOthersOnDeactivation`). Skipped while composer dictation owns the
    /// mic — same guard as activation. If another clip is still playing, iOS
    /// refuses to deactivate a session with running I/O and `try?` swallows it,
    /// so this never cuts off an active clip.
    private func deactivateSession() {
        guard !ComposerAudioCaptureState.shared.isCapturing else { return }
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }

    private func startTicker() {
        stopTicker()
        // `.common` so the timer keeps firing while the transcript is scrolling.
        let timer = Timer(timeInterval: 0.2, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        RunLoop.main.add(timer, forMode: .common)
        ticker = timer
    }

    private func tick() {
        guard scrubTime == nil, let player else { return }
        currentTime = player.currentTime
    }

    private func stopTicker() {
        ticker?.invalidate()
        ticker = nil
    }

    deinit {
        ticker?.invalidate()
    }
}

/// `AVAudioPlayerDelegate` is `@objc` and can't live on an `@Observable`
/// `@MainActor` class, so a tiny `NSObject` proxy forwards the finish callback.
private final class AudioPlayerDelegateProxy: NSObject, AVAudioPlayerDelegate {
    var onFinish: (() -> Void)?
    var onDecodeError: (() -> Void)?

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        onFinish?()
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: (any Error)?) {
        onDecodeError?()
    }
}
