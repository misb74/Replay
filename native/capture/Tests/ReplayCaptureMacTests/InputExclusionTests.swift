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
        activatedBundleId: "com.github.Electron",
        activatedWindowTitle: "Replay — Live tutor",
        lastRecorded: (bundleId: "com.apple.Safari", windowTitle: "Example Domain"),
        excluded: [4321]
    ) == false)
}

@Test func returningToTheLastRecordedApplicationProducesNoSwitch() {
    #expect(shouldRecordAppSwitch(
        activatedProcessId: 1234,
        activatedBundleId: "com.apple.Safari",
        activatedWindowTitle: "Example Domain",
        lastRecorded: (bundleId: "com.apple.Safari", windowTitle: "Example Domain"),
        excluded: []
    ) == false)
}

@Test func switchingToAGenuinelyDifferentApplicationStillProducesOne() {
    #expect(shouldRecordAppSwitch(
        activatedProcessId: 5678,
        activatedBundleId: "com.apple.Terminal",
        activatedWindowTitle: "zsh",
        lastRecorded: (bundleId: "com.apple.Safari", windowTitle: "Example Domain"),
        excluded: []
    ) == true)
}

@Test func sameApplicationWithADifferentWindowTitleStillProducesASwitch() {
    // The equality check in the brief is on bundle id AND window title
    // together, so a window change within the same application must still
    // count as a switch.
    #expect(shouldRecordAppSwitch(
        activatedProcessId: 1234,
        activatedBundleId: "com.apple.Safari",
        activatedWindowTitle: "A different tab",
        lastRecorded: (bundleId: "com.apple.Safari", windowTitle: "Example Domain"),
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
        activatedBundleId: "com.github.Electron",
        activatedWindowTitle: "Replay",
        lastRecorded: (bundleId: "com.apple.Safari", windowTitle: "Example Domain"),
        excluded: excluded
    ) == false)
    #expect(shouldRecordAppSwitch(
        activatedProcessId: 9999,
        activatedBundleId: "com.github.Electron",
        activatedWindowTitle: "Slack",
        lastRecorded: (bundleId: "com.apple.Safari", windowTitle: "Example Domain"),
        excluded: excluded
    ) == true)
}
