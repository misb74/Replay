import Testing
@testable import ReplayCaptureMac

@Test func excludedPointerTargetIsDropped() {
    #expect(shouldRecordInput(targetProcessId: 4321, excluded: [4321]) == false)
}

@Test func nonExcludedPointerTargetIsKept() {
    #expect(shouldRecordInput(targetProcessId: 1234, excluded: [4321]) == true)
}

@Test func emptyExclusionSetKeepsEverything() {
    #expect(shouldRecordInput(targetProcessId: 4321, excluded: []) == true)
}

@Test func excludedActivationIsDropped() {
    #expect(shouldRecordAppSwitch(
        activatedProcessId: 4321,
        lastRecordedProcessId: 1234,
        excluded: [4321]
    ) == false)
}

@Test func returningToTheLastRecordedApplicationProducesNoSwitch() {
    #expect(shouldRecordAppSwitch(
        activatedProcessId: 1234,
        lastRecordedProcessId: 1234,
        excluded: []
    ) == false)
}

@Test func switchingToAGenuinelyDifferentApplicationStillProducesOne() {
    #expect(shouldRecordAppSwitch(
        activatedProcessId: 5678,
        lastRecordedProcessId: 1234,
        excluded: []
    ) == true)
}

@Test func sameProcessReactivatedProducesNoSwitchEvenWithAnUnreadableTitle() {
    // The switch-back decision no longer takes a window title at all, so an
    // accessibility read that races the window becoming readable and
    // returns nil exactly at activation has no way to invent a switch. The
    // process id is the only signal, and it is unaffected by that race.
    #expect(shouldRecordAppSwitch(
        activatedProcessId: 1234,
        lastRecordedProcessId: 1234,
        excluded: []
    ) == false)
}

@Test func twoProcessesSharingABundleIdAndWindowTitleStillProduceASwitch() {
    // The reverse case: two processes that happen to report the same
    // bundle id — which two Electron processes always do in development —
    // and the same, or equally unreadable, window
    // title must not be mistaken for one application. Since neither is even
    // an input to this function any more, that coincidence cannot suppress
    // a genuine switch between two different process ids.
    #expect(shouldRecordAppSwitch(
        activatedProcessId: 9999,
        lastRecordedProcessId: 4321,
        excluded: []
    ) == true)
}

@Test func excludedActivationLeavesTheLastRecordedProcessUnchangedSoReturningProducesNoSwitch() {
    let originalProcessId: Int32 = 1234
    let excludedProcessId: Int32 = 4321
    let excluded: Set<Int32> = [excludedProcessId]

    // The excluded activation is dropped...
    #expect(shouldRecordAppSwitch(
        activatedProcessId: excludedProcessId,
        lastRecordedProcessId: originalProcessId,
        excluded: excluded
    ) == false)

    // ...so a caller that only advances its last-recorded process id when
    // this function says to record (as MacInputMonitor does) never moves it
    // away from `originalProcessId`. Returning to it afterwards, with that
    // same last-recorded process id still in force, must see no switch.
    #expect(shouldRecordAppSwitch(
        activatedProcessId: originalProcessId,
        lastRecordedProcessId: originalProcessId,
        excluded: excluded
    ) == false)
}

@Test func firstActivationWithNoLastRecordedProcessProducesASwitch() {
    #expect(shouldRecordAppSwitch(
        activatedProcessId: 1234,
        lastRecordedProcessId: nil,
        excluded: []
    ) == true)
}

@Test func twoElectronApplicationsWithTheSameBundleIdAreDistinguishedByProcessId() {
    // In development every Electron app reports "com.github.Electron", so
    // only the process id may decide which one is excluded.
    let excluded: Set<Int32> = [4321]

    #expect(shouldRecordInput(targetProcessId: 4321, excluded: excluded) == false)
    #expect(shouldRecordInput(targetProcessId: 9999, excluded: excluded) == true)

    #expect(shouldRecordAppSwitch(
        activatedProcessId: 4321,
        lastRecordedProcessId: 1234,
        excluded: excluded
    ) == false)
    #expect(shouldRecordAppSwitch(
        activatedProcessId: 9999,
        lastRecordedProcessId: 1234,
        excluded: excluded
    ) == true)
}

@Test func eventWithAnUnknownTargetProcessLeavesTheTrackedPidUnchanged() {
    // Round-2 regression: process(type:event:) must never overwrite the
    // tracked pid with 0 (unknown — e.g. a keyDown with no frontmost
    // application reported), or a later legitimate activation of the
    // application the user was already in would be misreported as a switch.
    let afterUnknownEvent = nextRecordedProcessId(current: 1234, targetProcessId: 0)
    #expect(afterUnknownEvent == 1234)
    #expect(shouldRecordAppSwitch(
        activatedProcessId: 1234,
        lastRecordedProcessId: afterUnknownEvent,
        excluded: []
    ) == false)
}

@Test func activationWithAnUnknownPidProducesNoSwitch() {
    // An activation notification with no resolvable NSRunningApplication
    // falls back to pid 0 in applicationActivated. It must be treated as no
    // signal at all: no switch, and — since MacInputMonitor only writes its
    // tracked state when this returns true — no change to what's tracked.
    #expect(shouldRecordAppSwitch(
        activatedProcessId: 0,
        lastRecordedProcessId: 1234,
        excluded: []
    ) == false)
}

@Test func aNegativePidBehavesLikeZero() {
    #expect(nextRecordedProcessId(current: 1234, targetProcessId: -1) == 1234)
    #expect(shouldRecordAppSwitch(
        activatedProcessId: -1,
        lastRecordedProcessId: 1234,
        excluded: []
    ) == false)
}

@Test func aRealPidStillUpdatesTheTrackedPidAndADifferentRealPidStillProducesASwitch() {
    // Confirms the guards against an unknown process id leave the
    // ordinary, real-pid path alone.
    #expect(nextRecordedProcessId(current: 1234, targetProcessId: 5678) == 5678)
    #expect(shouldRecordAppSwitch(
        activatedProcessId: 5678,
        lastRecordedProcessId: 1234,
        excluded: []
    ) == true)
}
