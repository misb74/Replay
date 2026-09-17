import AVFoundation
import Foundation
import Testing
@testable import ReplayCaptureMac

/// `AVAudioConverter` is a pure signal-processing object: it opens no
/// device, reads no microphone and produces no sound. So the conversion
/// every live audio path depends on — the narration file's, the analyser's,
/// and the synthesiser's playback — can be checked here for real, with
/// synthetic buffers, without any of what Amendment A forbids.
///
/// What these pin down is that a converted stream contains its source audio
/// exactly once. `convertToBuffer:error:withInputFromBlock:` fills the
/// output to its *capacity*, and `AVAudioConverter.h` says of the block's
/// packet count that "you may supply more or less than this amount. If
/// less, then the input block will get called again" — so an input block
/// that keeps handing back the same buffer makes the converter read it
/// again from frame zero and append the repeat.
///
/// The converter emits in fixed internal blocks rather than matching its
/// output to the buffer it was just given, so a single call's frame count
/// is not the thing to assert. What matters, and what the analyser's
/// contiguous timeline and `audio.m4a`'s duration both rest on, is that
/// over a run of buffers the frames out match the frames in: never more
/// (audio repeated) and never falling further and further behind (audio
/// lost).

private let sourceFrames: AVAudioFrameCount = 4_800

/// Fills `buffer` with a ramp from 0 to 1 across its length, on every
/// channel. A ramp makes repeated audio obvious: a correct conversion ends
/// near where the ramp ended, while a second pass over the head of the same
/// input ends near zero.
private func makeRamp(_ format: AVAudioFormat) -> AVAudioPCMBuffer? {
    guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: sourceFrames) else { return nil }
    buffer.frameLength = sourceFrames
    guard let channels = buffer.floatChannelData else { return nil }
    for channel in 0..<Int(format.channelCount) {
        for frame in 0..<Int(sourceFrames) {
            channels[channel][frame] = Float(frame) / Float(sourceFrames)
        }
    }
    return buffer
}

private func samples(of buffer: AVAudioPCMBuffer) -> [Float] {
    guard let channels = buffer.floatChannelData else { return [] }
    return Array(UnsafeBufferPointer(start: channels[0], count: Int(buffer.frameLength)))
}

/// One internal block of slack, which is as far behind as the converter is
/// ever allowed to be at the moment a run is measured.
private let allowedLagFrames = 4_096

private func checkConversionRun(
    from source: AVAudioFormat,
    to target: AVAudioFormat,
    downmix: Bool,
    buffers: Int
) throws {
    let converter = try #require(AVAudioConverter(from: source, to: target))
    converter.primeMethod = .none
    converter.downmix = downmix
    let input = try #require(makeRamp(source))
    let expectedPerBuffer = Int((Double(sourceFrames) * target.sampleRate / source.sampleRate).rounded())

    var total = 0
    for _ in 0..<buffers {
        let converted = try convertAudioBuffer(input, using: converter, to: target).get()
        total += Int(converted.frameLength)
    }

    let ideal = expectedPerBuffer * buffers
    #expect(
        total <= ideal,
        "\(buffers) buffers of \(sourceFrames) frames are \(ideal) frames out; more than that is the same input converted twice (got \(total))"
    )
    #expect(
        ideal - total <= allowedLagFrames,
        "the converter may hold back at most one internal block; a shortfall that grows with the run means audio is being dropped (got \(total) of \(ideal))"
    )
}

/// The tap-to-analyser shape: 48kHz down to the 16kHz the on-device speech
/// model wants.
@Test func resamplingConservesFramesOverARun() throws {
    let source = try #require(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1))
    let target = try #require(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))

    try checkConversionRun(from: source, to: target, downmix: false, buffers: 10)
}

/// The same, over a much longer run. A converter that lost a slice of every
/// buffer would pass the short run and fail here, because the shortfall
/// would grow with the number of buffers instead of staying inside one
/// block.
@Test func resamplingDoesNotFallFurtherBehindOverALongRun() throws {
    let source = try #require(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1))
    let target = try #require(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))

    try checkConversionRun(from: source, to: target, downmix: false, buffers: 200)
}

/// The tap-to-narration shape: many channels mixed down to the one mono
/// channel `audio.m4a` is written in, at the tap's own sample rate.
@Test func downmixingConservesFramesOverARun() throws {
    let source = try #require(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2))
    let target = try #require(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1))

    try checkConversionRun(from: source, to: target, downmix: true, buffers: 200)
}

/// The head of the source must not reappear at the tail of the output.
/// Frame counts alone would not catch a converter that read the same input
/// twice into a correctly sized buffer.
@Test func aConvertedBufferDoesNotRepeatTheHeadOfItsSource() throws {
    let source = try #require(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2))
    let target = try #require(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1))
    let converter = try #require(AVAudioConverter(from: source, to: target))
    converter.primeMethod = .none
    converter.downmix = true
    let input = try #require(makeRamp(source))

    let converted = try convertAudioBuffer(input, using: converter, to: target).get()

    let tail = samples(of: converted).suffix(32)
    #expect(!tail.isEmpty)
    #expect(
        tail.allSatisfy { $0 > 0.5 },
        "a rising ramp must still be rising at its end; a tail back near zero is the head of the same buffer converted a second time"
    )
}

/// The narration converter mixes its channels rather than picking the first
/// one, so hardware whose voice-processed channels genuinely differ still
/// records usable narration.
@Test func downmixingMixesTheChannelsRatherThanTakingTheFirst() throws {
    let source = try #require(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2))
    let target = try #require(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1))
    let converter = try #require(AVAudioConverter(from: source, to: target))
    converter.primeMethod = .none
    converter.downmix = true
    // Channel 0 silent, channel 1 carrying the signal: what a remap would
    // produce is silence, what a mix produces is audible.
    let input = try #require(AVAudioPCMBuffer(pcmFormat: source, frameCapacity: sourceFrames))
    input.frameLength = sourceFrames
    let channels = try #require(input.floatChannelData)
    for frame in 0..<Int(sourceFrames) {
        channels[0][frame] = 0
        channels[1][frame] = 0.8
    }

    let converted = try convertAudioBuffer(input, using: converter, to: target).get()

    let loudest = samples(of: converted).map(abs).max() ?? 0
    #expect(loudest > 0.1, "a downmix must carry channel 1's signal, not just read channel 0: peak was \(loudest)")
}
