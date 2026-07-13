import Foundation

enum AppTab: Hashable {
    case today
    case inbox
    case tasks
    case more
}

struct DailyBriefing {
    let greeting: String
    let focus: String
    let schedule: [ScheduleItem]
    let priorities: [LifeTask]
    let attentionCount: Int
}

struct ScheduleItem: Identifiable {
    let id: UUID
    let time: String
    let title: String
    let detail: String
    let symbol: String
}

enum InboxFilter: String, CaseIterable, Identifiable {
    case forYou = "For you"
    case activity = "Activity"
    case approvals = "Approvals"

    var id: Self { self }
}

enum InboxTone {
    case question
    case receipt
    case proposal
    case update
}

struct InboxItem: Identifiable {
    let id: UUID
    let category: InboxFilter
    let tone: InboxTone
    let title: String
    let summary: String
    let relativeTime: String
    let symbol: String
    let actionLabel: String?
}

enum TaskPriority: String {
    case high = "High"
    case normal = "Normal"
    case low = "Low"
}

struct LifeTask: Identifiable {
    let id: UUID
    let title: String
    let project: String
    let dueLabel: String?
    let priority: TaskPriority
    let isComplete: Bool
}

struct TaskDetail {
    let taskID: UUID
    let summary: String
    let intendedOutcome: String
    let nextStep: String
    let progress: Double
    let vaultContext: [TaskContextItem]
    let agentCommentary: AgentCommentary?
}

struct TaskContextItem: Identifiable {
    let id: UUID
    let sourceLabel: String
    let title: String
    let summary: String
    let updatedLabel: String
    let symbol: String
}

struct AgentCommentary {
    let headline: String
    let body: String
    let suggestions: [String]
    let generatedLabel: String
}

struct SystemStatus {
    let isConnected: Bool
    let isReadOnly: Bool
    let lastSync: String
    let enabledSources: [String]
}
