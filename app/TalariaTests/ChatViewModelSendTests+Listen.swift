import XCTest
import AVFoundation
import ImageIO
import SwiftData
import UIKit
import UniformTypeIdentifiers
@testable import Talaria
@testable import TalariaKit

@MainActor
extension ChatViewModelSendTests {
    func testOpeningSessionDoesNotCreateSpeechSynthesizer() throws {
        var createdSynthesizers = 0

        _ = try makeViewModel(
            speechSynthesizerFactory: {
                createdSynthesizers += 1
                return SpySpeechSynthesizer()
            }
        ) { request in
            XCTFail("Opening a session should not request network work in this test.")
            return apiTestJSONResponse("{}", for: request)
        }

        XCTAssertEqual(createdSynthesizers, 0)
    }

    @MainActor
    func testListenCreatesSpeechSynthesizerOnlyWhenRequested() async throws {
        let speechSynthesizer = SpySpeechSynthesizer()
        var createdSynthesizers = 0
        let viewModel = try makeViewModel(
            speechSynthesizerFactory: {
                createdSynthesizers += 1
                return speechSynthesizer
            }
        ) { request in
            // Listen now prefers server TTS (#15); refuse it so the on-device
            // fallback path is what creates the synthesizer.
            XCTAssertEqual(request.url?.path, "/api/tts")
            return Self.ttsUnavailableResponse(for: request)
        }
        let context = try XCTUnwrap(MessageActionContext(
            message: ChatMessage(
                role: "assistant",
                content: "Playback should be explicit.",
                timestamp: 1_770_000_001,
                messageId: "assistant-1"
            ),
            visibleIndex: 0,
            messagesOffset: 0
        ))

        viewModel.toggleListening(to: context)
        XCTAssertEqual(viewModel.listeningMessageID, "assistant-1")
        await viewModel.listenPreparationTask?.value

        XCTAssertEqual(createdSynthesizers, 1)
        XCTAssertEqual(speechSynthesizer.spokenStrings, ["Playback should be explicit."])
        XCTAssertEqual(viewModel.listeningMessageID, "assistant-1")
    }

    func testListenAudioSessionRoutesToSpeakerNotEarpiece() {
        // `.playback` forces the speaker (not the receiver/earpiece) by default, and
        // `.spokenAudio` is Apple's recommended mode for synthesized speech. #252.
        XCTAssertEqual(ListenAudioSessionConfiguration.category, .playback)
        XCTAssertEqual(ListenAudioSessionConfiguration.mode, .spokenAudio)
        XCTAssertTrue(
            ListenAudioSessionConfiguration.deactivationOptions.contains(.notifyOthersOnDeactivation)
        )
    }

    @MainActor
    func testListenActivatesAudioSessionBeforeSpeaking() async throws {
        let recorder = ListenCallRecorder()
        let speechSynthesizer = SpySpeechSynthesizer(recorder: recorder)
        let audioSession = SpyListenAudioSession(recorder: recorder)
        let viewModel = try makeViewModel(
            speechSynthesizerFactory: { speechSynthesizer },
            listenAudioSession: audioSession
        ) { request in
            Self.ttsUnavailableResponse(for: request)
        }
        let context = try XCTUnwrap(MessageActionContext(
            message: ChatMessage(
                role: "assistant",
                content: "Out loud, please.",
                timestamp: 1_770_000_002,
                messageId: "assistant-2"
            ),
            visibleIndex: 0,
            messagesOffset: 0
        ))

        viewModel.toggleListening(to: context)
        // Regression (review on #35): the tap itself must NOT activate the session —
        // a slow `/api/tts` fetch would otherwise silence other audio while Talaria
        // has nothing to play. Activation belongs to the moment playback starts.
        XCTAssertEqual(audioSession.activateCount, 0)
        await viewModel.listenPreparationTask?.value

        XCTAssertEqual(audioSession.activateCount, 1)
        XCTAssertEqual(speechSynthesizer.spokenStrings, ["Out loud, please."])
        // Prove activate precedes speak on a single interleaved timeline shared by both
        // spies (the audio session and the synthesizer), so the "before speaking" claim
        // is provable rather than relying on two independent logs (review on #332).
        let activateIndex = try XCTUnwrap(recorder.events.firstIndex(of: "activate"))
        let speakIndex = try XCTUnwrap(recorder.events.firstIndex(of: "speak"))
        XCTAssertLessThan(activateIndex, speakIndex)
    }

    @MainActor
    func testStaleCancelAfterSwitchingMessagesKeepsNewListenActive() async throws {
        let speechSynthesizer = SpySpeechSynthesizer()
        let audioSession = SpyListenAudioSession()
        let viewModel = try makeViewModel(
            speechSynthesizerFactory: { speechSynthesizer },
            listenAudioSession: audioSession
        ) { request in
            Self.ttsUnavailableResponse(for: request)
        }
        func makeContext(_ id: String, _ text: String, _ timestamp: Double) throws -> MessageActionContext {
            try XCTUnwrap(MessageActionContext(
                message: ChatMessage(role: "assistant", content: text, timestamp: timestamp, messageId: id),
                visibleIndex: 0,
                messagesOffset: 0
            ))
        }

        // Start listening to A, then switch to B while A is still "speaking".
        viewModel.toggleListening(to: try makeContext("assistant-A", "First message.", 1_770_000_010))
        await viewModel.listenPreparationTask?.value
        let utteranceA = try XCTUnwrap(speechSynthesizer.spokenUtterances.first)
        viewModel.toggleListening(to: try makeContext("assistant-B", "Second message.", 1_770_000_011))
        await viewModel.listenPreparationTask?.value

        XCTAssertEqual(viewModel.listeningMessageID, "assistant-B")
        let deactivationsBeforeStaleCallback = audioSession.deactivateCount

        // A's cancel callback now arrives late, after B has started speaking. It must be
        // ignored so it can't clear B's "now playing" state or deactivate the session.
        speechSynthesizer.fireDidCancel(utteranceA)
        await drainMainActor()

        XCTAssertEqual(viewModel.listeningMessageID, "assistant-B")
        XCTAssertEqual(audioSession.deactivateCount, deactivationsBeforeStaleCallback)

        // A matching completion (for the live utterance B) still tears down cleanly.
        let utteranceB = try XCTUnwrap(speechSynthesizer.spokenUtterances.last)
        speechSynthesizer.fireDidCancel(utteranceB)
        await drainMainActor()

        XCTAssertNil(viewModel.listeningMessageID)
        XCTAssertEqual(audioSession.deactivateCount, deactivationsBeforeStaleCallback + 1)
    }

    @MainActor
    func testStoppingListeningReleasesAudioSession() async throws {
        let speechSynthesizer = SpySpeechSynthesizer()
        let audioSession = SpyListenAudioSession()
        let viewModel = try makeViewModel(
            speechSynthesizerFactory: { speechSynthesizer },
            listenAudioSession: audioSession
        ) { request in
            Self.ttsUnavailableResponse(for: request)
        }
        let context = try XCTUnwrap(MessageActionContext(
            message: ChatMessage(
                role: "assistant",
                content: "Stop me cleanly.",
                timestamp: 1_770_000_003,
                messageId: "assistant-3"
            ),
            visibleIndex: 0,
            messagesOffset: 0
        ))

        viewModel.toggleListening(to: context)
        await viewModel.listenPreparationTask?.value
        let deactivationsAfterStart = audioSession.deactivateCount

        viewModel.stopListening()

        XCTAssertGreaterThan(audioSession.deactivateCount, deactivationsAfterStart)
        XCTAssertNil(viewModel.listeningMessageID)
    }

    @MainActor
    func testListenPrefersServerTTSAndPlaysReturnedAudio() async throws {
        let audioSession = SpyListenAudioSession()
        let remoteControlCenter = SpyListenRemoteControlCenter()
        let userDefaults = try makeEphemeralUserDefaults()
        let player = SpyListenAudioPlayer()
        player.duration = 83
        var receivedAudioData: [Data] = []
        var createdSynthesizers = 0
        let serverAudio = Data([0xFF, 0xF3, 0x18, 0xC4])
        let viewModel = try makeViewModel(
            speechSynthesizerFactory: {
                createdSynthesizers += 1
                return SpySpeechSynthesizer()
            },
            listenAudioSession: audioSession,
            listenRemoteControlCenter: remoteControlCenter,
            serverTTSAudioPlayerFactory: { data in
                receivedAudioData.append(data)
                return player
            },
            userDefaults: userDefaults
        ) { request in
            XCTAssertEqual(request.url?.path, "/api/tts")
            guard let body = apiTestBodyData(from: request),
                  let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else {
                XCTFail("Missing TTS request body")
                throw URLError(.badServerResponse)
            }
            XCTAssertEqual(json["text"] as? String, "Neural, please.")
            XCTAssertEqual(json["voice"] as? String, ServerTTSPolicy.defaultVoice)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "audio/mpeg"]
            )!
            return (response, serverAudio)
        }
        let context = try XCTUnwrap(MessageActionContext(
            message: ChatMessage(
                role: "assistant",
                content: "Neural, please.",
                timestamp: 1_770_000_020,
                messageId: "assistant-20"
            ),
            visibleIndex: 0,
            messagesOffset: 0
        ))

        viewModel.toggleListening(to: context)
        XCTAssertTrue(viewModel.showsListenPlaybackBar)
        XCTAssertEqual(viewModel.listenPlaybackPhase, .loading)
        // Regression (review on #35): no session activation while the fetch is in
        // flight — only once decoded server audio is about to play.
        XCTAssertEqual(audioSession.activateCount, 0)
        await viewModel.listenPreparationTask?.value

        // Server audio plays; the on-device synthesizer is never touched.
        XCTAssertEqual(receivedAudioData, [serverAudio])
        XCTAssertEqual(player.prepareToPlayCount, 1)
        XCTAssertEqual(player.playCount, 1)
        XCTAssertEqual(player.rate, Float(1))
        XCTAssertEqual(createdSynthesizers, 0)
        XCTAssertEqual(viewModel.listeningMessageID, "assistant-20")
        XCTAssertTrue(viewModel.showsListenPlaybackBar)
        XCTAssertEqual(viewModel.listenPlaybackPhase, .playing)
        XCTAssertEqual(viewModel.listenPlaybackDuration, 83)
        XCTAssertEqual(audioSession.activateCount, 1)
        XCTAssertEqual(remoteControlCenter.configureCount, 1)
        XCTAssertEqual(remoteControlCenter.snapshots.last, ListenNowPlayingSnapshot(
            title: "Talaria response 1",
            duration: 83,
            elapsedTime: 0,
            speed: .normal,
            isPlaying: true
        ))

        // Natural finish tears listen state down and releases the session. The
        // defensive stopListening() at the start of toggleListening also
        // deactivates once, so assert the finish-driven delta, not a total.
        let deactivationsBeforeFinish = audioSession.deactivateCount
        player.finishPlayback()
        XCTAssertNil(viewModel.listeningMessageID)
        XCTAssertFalse(viewModel.showsListenPlaybackBar)
        XCTAssertGreaterThan(audioSession.deactivateCount, deactivationsBeforeFinish)
    }

    @MainActor
    func testListenPlaybackCanPauseResumeSeekAndUseRemoteCommands() async throws {
        let player = SpyListenAudioPlayer()
        player.duration = 120
        let remoteControlCenter = SpyListenRemoteControlCenter()
        let viewModel = try makeViewModel(
            listenRemoteControlCenter: remoteControlCenter,
            serverTTSAudioPlayerFactory: { _ in player }
        ) { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "audio/mpeg"]
            )!
            return (response, Data([0xFF, 0xF3]))
        }
        let context = try XCTUnwrap(MessageActionContext(
            message: ChatMessage(
                role: "assistant",
                content: "Give me controls.",
                timestamp: 1_770_000_025,
                messageId: "assistant-25"
            ),
            visibleIndex: 0,
            messagesOffset: 0
        ))

        viewModel.toggleListening(to: context)
        await viewModel.listenPreparationTask?.value

        remoteControlCenter.firePause()
        XCTAssertEqual(player.pauseCount, 1)
        XCTAssertEqual(viewModel.listenPlaybackPhase, .paused)
        XCTAssertFalse(try XCTUnwrap(remoteControlCenter.snapshots.last).isPlaying)

        remoteControlCenter.firePlay()
        XCTAssertEqual(player.playCount, 2)
        XCTAssertEqual(viewModel.listenPlaybackPhase, .playing)
        XCTAssertTrue(try XCTUnwrap(remoteControlCenter.snapshots.last).isPlaying)

        remoteControlCenter.fireChangePlaybackPosition(37)
        XCTAssertEqual(player.currentTime, 37)
        XCTAssertEqual(viewModel.listenPlaybackElapsedTime, 37)

        viewModel.toggleListenPlaybackPlayPause()
        XCTAssertEqual(player.pauseCount, 2)
        XCTAssertEqual(viewModel.listenPlaybackPhase, .paused)

        remoteControlCenter.fireTogglePlayPause()
        XCTAssertEqual(player.playCount, 3)
        XCTAssertEqual(viewModel.listenPlaybackPhase, .playing)
    }

    @MainActor
    func testListenPlaybackResyncsProgressWhenSceneBecomesActive() async throws {
        let player = SpyListenAudioPlayer()
        player.duration = 90
        let remoteControlCenter = SpyListenRemoteControlCenter()
        let viewModel = try makeViewModel(
            listenRemoteControlCenter: remoteControlCenter,
            serverTTSAudioPlayerFactory: { _ in player }
        ) { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "audio/mpeg"]
            )!
            return (response, Data([0xFF, 0xF3]))
        }
        let context = try XCTUnwrap(MessageActionContext(
            message: ChatMessage(
                role: "assistant",
                content: "Keep progress honest.",
                timestamp: 1_770_000_026,
                messageId: "assistant-26"
            ),
            visibleIndex: 0,
            messagesOffset: 0
        ))

        viewModel.toggleListening(to: context)
        await viewModel.listenPreparationTask?.value
        XCTAssertEqual(viewModel.listenPlaybackElapsedTime, 0)
        let nowPlayingUpdatesAfterStart = remoteControlCenter.snapshots.count

        // Simulates background audio advancing while the foreground UI timer is not
        // firing. Returning to the scene must pull the latest player time into the bar.
        player.currentTime = 42
        viewModel.refreshListenPlaybackProgressAfterSceneActivation()

        XCTAssertEqual(viewModel.listenPlaybackElapsedTime, 42)
        XCTAssertEqual(viewModel.listenPlaybackDisplayTime, 42)
        XCTAssertEqual(remoteControlCenter.snapshots.count, nowPlayingUpdatesAfterStart)
    }

    @MainActor
    func testListenPlaybackSeekAndSpeedPersist() async throws {
        let userDefaults = try makeEphemeralUserDefaults()
        let player = SpyListenAudioPlayer()
        player.duration = 120
        let viewModel = try makeViewModel(
            serverTTSAudioPlayerFactory: { _ in player },
            userDefaults: userDefaults
        ) { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "audio/mpeg"]
            )!
            return (response, Data([0xFF, 0xF3]))
        }
        let context = try XCTUnwrap(MessageActionContext(
            message: ChatMessage(
                role: "assistant",
                content: "Remember my speed.",
                timestamp: 1_770_000_026,
                messageId: "assistant-26"
            ),
            visibleIndex: 0,
            messagesOffset: 0
        ))

        viewModel.toggleListening(to: context)
        await viewModel.listenPreparationTask?.value

        viewModel.scrubListenPlayback(to: 64)
        XCTAssertEqual(viewModel.listenPlaybackDisplayTime, 64)
        XCTAssertEqual(player.currentTime, 0)

        viewModel.setListenPlaybackScrubbing(false)
        XCTAssertEqual(player.currentTime, 64)
        XCTAssertEqual(viewModel.listenPlaybackElapsedTime, 64)
        XCTAssertNil(viewModel.listenPlaybackScrubTime)

        viewModel.setListenPlaybackSpeed(.oneAndHalf)
        XCTAssertEqual(player.rate, Float(1.5))
        XCTAssertEqual(userDefaults.double(forKey: ListenPlaybackSpeed.storageKey), 1.5)

        let reloadedViewModel = try makeViewModel(userDefaults: userDefaults) { request in
            XCTFail("Reading stored playback speed should not hit \(request.url?.path ?? "unknown path")")
            throw URLError(.badServerResponse)
        }
        XCTAssertEqual(reloadedViewModel.listenPlaybackSpeed, .oneAndHalf)
    }

    @MainActor
    func testStartingListenOnDifferentMessageStopsCurrentServerAudio() async throws {
        let firstPlayer = SpyListenAudioPlayer()
        let secondPlayer = SpyListenAudioPlayer()
        var players = [firstPlayer, secondPlayer]
        let viewModel = try makeViewModel(
            serverTTSAudioPlayerFactory: { _ in
                players.removeFirst()
            }
        ) { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "audio/mpeg"]
            )!
            return (response, Data([0xFF, 0xF3]))
        }
        func makeContext(_ id: String, text: String, visibleIndex: Int) throws -> MessageActionContext {
            try XCTUnwrap(MessageActionContext(
                message: ChatMessage(role: "assistant", content: text, timestamp: 1_770_000_030, messageId: id),
                visibleIndex: visibleIndex,
                messagesOffset: 0
            ))
        }

        viewModel.toggleListening(to: try makeContext("assistant-30", text: "First audio.", visibleIndex: 0))
        await viewModel.listenPreparationTask?.value
        viewModel.toggleListening(to: try makeContext("assistant-31", text: "Second audio.", visibleIndex: 1))
        await viewModel.listenPreparationTask?.value

        XCTAssertEqual(firstPlayer.stopCount, 1)
        XCTAssertEqual(secondPlayer.playCount, 1)
        XCTAssertEqual(viewModel.listeningMessageID, "assistant-31")
        XCTAssertEqual(viewModel.listenPlaybackPhase, .playing)
    }

    @MainActor
    func testListenFallsBackToSynthesizerSilentlyWhenServerTTSFails() async throws {
        let speechSynthesizer = SpySpeechSynthesizer()
        var playerFactoryCalls = 0
        let viewModel = try makeViewModel(
            speechSynthesizerFactory: { speechSynthesizer },
            serverTTSAudioPlayerFactory: { _ in
                playerFactoryCalls += 1
                return SpyListenAudioPlayer()
            }
        ) { request in
            // A raw 429 from the ~2 s rate limit must never surface to the user.
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 429,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            return (response, Data(#"{"error": "rate limit exceeded — please wait"}"#.utf8))
        }
        let context = try XCTUnwrap(MessageActionContext(
            message: ChatMessage(
                role: "assistant",
                content: "Fall back quietly.",
                timestamp: 1_770_000_021,
                messageId: "assistant-21"
            ),
            visibleIndex: 0,
            messagesOffset: 0
        ))

        viewModel.toggleListening(to: context)
        await viewModel.listenPreparationTask?.value

        XCTAssertEqual(playerFactoryCalls, 0)
        XCTAssertEqual(speechSynthesizer.spokenStrings, ["Fall back quietly."])
        XCTAssertEqual(viewModel.listeningMessageID, "assistant-21")
        // Silent fallback: no error alert for the user (#15).
        XCTAssertNil(viewModel.messageActionErrorMessage)
    }

    @MainActor
    func testListenFallsBackToSynthesizerWhenServerAudioIsUndecodable() async throws {
        let speechSynthesizer = SpySpeechSynthesizer()
        let viewModel = try makeViewModel(
            speechSynthesizerFactory: { speechSynthesizer },
            serverTTSAudioPlayerFactory: { _ in
                throw URLError(.cannotDecodeContentData)
            }
        ) { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "audio/mpeg"]
            )!
            return (response, Data("not really audio".utf8))
        }
        let context = try XCTUnwrap(MessageActionContext(
            message: ChatMessage(
                role: "assistant",
                content: "Bad bytes, good fallback.",
                timestamp: 1_770_000_022,
                messageId: "assistant-22"
            ),
            visibleIndex: 0,
            messagesOffset: 0
        ))

        viewModel.toggleListening(to: context)
        await viewModel.listenPreparationTask?.value

        XCTAssertEqual(speechSynthesizer.spokenStrings, ["Bad bytes, good fallback."])
        XCTAssertNil(viewModel.messageActionErrorMessage)
    }

    @MainActor
    func testListenOverServerLimitSkipsServerTTSEntirely() async throws {
        let speechSynthesizer = SpySpeechSynthesizer()
        let viewModel = try makeViewModel(
            speechSynthesizerFactory: { speechSynthesizer }
        ) { request in
            XCTFail("Text over the 5000-char cap must not hit /api/tts.")
            return apiTestJSONResponse("{}", for: request)
        }
        let longText = String(repeating: "a", count: ServerTTSPolicy.maximumTextLength + 1)
        let context = try XCTUnwrap(MessageActionContext(
            message: ChatMessage(
                role: "assistant",
                content: longText,
                timestamp: 1_770_000_023,
                messageId: "assistant-23"
            ),
            visibleIndex: 0,
            messagesOffset: 0
        ))

        viewModel.toggleListening(to: context)

        // Straight to the on-device path — synchronous, no preparation task.
        XCTAssertNil(viewModel.listenPreparationTask)
        XCTAssertEqual(speechSynthesizer.spokenStrings, [longText])
        XCTAssertEqual(viewModel.listeningMessageID, "assistant-23")
    }

    @MainActor
    func testSecondTapWhileFetchingServerAudioStopsInsteadOfRestarting() async throws {
        let speechSynthesizer = SpySpeechSynthesizer()
        var playerFactoryCalls = 0
        var ttsRequests = 0
        let viewModel = try makeViewModel(
            speechSynthesizerFactory: { speechSynthesizer },
            serverTTSAudioPlayerFactory: { _ in
                playerFactoryCalls += 1
                return SpyListenAudioPlayer()
            }
        ) { request in
            ttsRequests += 1
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "audio/mpeg"]
            )!
            return (response, Data([0xFF, 0xF3]))
        }
        let context = try XCTUnwrap(MessageActionContext(
            message: ChatMessage(
                role: "assistant",
                content: "Tap tap.",
                timestamp: 1_770_000_024,
                messageId: "assistant-24"
            ),
            visibleIndex: 0,
            messagesOffset: 0
        ))

        viewModel.toggleListening(to: context)
        let firstFetch = viewModel.listenPreparationTask
        // Second tap lands while the server fetch is still in flight: it must act
        // as "Stop Listening", not queue a second /api/tts call (#15 double-tap).
        viewModel.toggleListening(to: context)

        XCTAssertNil(viewModel.listeningMessageID)
        XCTAssertNil(viewModel.listenPreparationTask)

        // Even if the first response completes after the stop, its stale request
        // ID must not start playback or speech.
        await firstFetch?.value
        XCTAssertEqual(playerFactoryCalls, 0)
        XCTAssertTrue(speechSynthesizer.spokenStrings.isEmpty)
        XCTAssertNil(viewModel.listeningMessageID)
        XCTAssertLessThanOrEqual(ttsRequests, 1)
    }

    func testServerTTSPolicyRoutesByServerTextCap() {
        XCTAssertTrue(ServerTTSPolicy.shouldUseServerTTS(for: String(repeating: "a", count: 5000)))
        XCTAssertFalse(ServerTTSPolicy.shouldUseServerTTS(for: String(repeating: "a", count: 5001)))
        XCTAssertEqual(ServerTTSPolicy.defaultVoice, "en-US-AriaNeural")
    }
}
