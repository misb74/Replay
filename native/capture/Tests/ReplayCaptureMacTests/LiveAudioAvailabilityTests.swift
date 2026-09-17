import Foundation
import Testing
@testable import ReplayCaptureMac

/// Whether this system has the on-device streaming speech the live tutor
/// needs. Tests that exercise types which only exist on macOS 26 are gated
/// on it with `.enabled(if:)` rather than returning early, so a run on an
/// older system reports them as skipped instead of passing without having
/// done anything.
let liveAudioIsAvailableOnThisSystem: Bool = {
    if #available(macOS 26, *) { return true }
    return false
}()

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
