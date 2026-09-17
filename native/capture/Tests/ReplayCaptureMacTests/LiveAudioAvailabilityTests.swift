import Foundation
import Testing
@testable import ReplayCaptureMac

/// The only part of the live audio stack that can be exercised without a
/// microphone: the factory decides, from the running system's version alone,
/// whether live audio is on offer at all. Constructing the provider must not
/// touch audio hardware, so this test stays silent — no engine, no
/// synthesiser, no input node, no sound.
@Test func liveAudioIsOfferedOnlyOnSupportedSystems() {
    let provider = makeLiveAudioProvider()
    if #available(macOS 26, *) {
        #expect(provider != nil)
    } else {
        #expect(provider == nil)
    }
}
