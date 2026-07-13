import Foundation

extension AppModel {
    static let preview = AppModel(
        briefing: DailyBriefing(
            greeting: "Good morning",
            focus: "Protect the morning for focused work. Two decisions need your attention before lunch.",
            schedule: [
                ScheduleItem(
                    id: UUID(uuidString: "10000000-0000-0000-0000-000000000001")!,
                    time: "9:00 AM",
                    title: "Product planning",
                    detail: "45 minutes",
                    symbol: "person.2"
                ),
                ScheduleItem(
                    id: UUID(uuidString: "10000000-0000-0000-0000-000000000002")!,
                    time: "12:30 PM",
                    title: "Lunch with Sam",
                    detail: "Downtown",
                    symbol: "fork.knife"
                ),
                ScheduleItem(
                    id: UUID(uuidString: "10000000-0000-0000-0000-000000000003")!,
                    time: "3:00 PM",
                    title: "Weekly review",
                    detail: "30 minutes",
                    symbol: "checklist"
                )
            ],
            priorities: [
                LifeTask(
                    id: UUID(uuidString: "20000000-0000-0000-0000-000000000001")!,
                    title: "Draft the iPhone prototype brief",
                    project: "LifeOS",
                    dueLabel: "Today",
                    priority: .high,
                    isComplete: false
                ),
                LifeTask(
                    id: UUID(uuidString: "20000000-0000-0000-0000-000000000002")!,
                    title: "Review quarterly goals",
                    project: "Personal planning",
                    dueLabel: "Today",
                    priority: .normal,
                    isComplete: false
                )
            ],
            attentionCount: 2
        ),
        inboxItems: [
            InboxItem(
                id: UUID(uuidString: "30000000-0000-0000-0000-000000000001")!,
                category: .forYou,
                tone: .question,
                title: "Which project owns this follow-up?",
                summary: "LifeOS found a commitment but could not safely infer its project.",
                relativeTime: "8m",
                symbol: "questionmark.bubble",
                actionLabel: "Clarify"
            ),
            InboxItem(
                id: UUID(uuidString: "30000000-0000-0000-0000-000000000002")!,
                category: .forYou,
                tone: .update,
                title: "Two dates may conflict",
                summary: "A proposed deadline overlaps with an existing calendar commitment.",
                relativeTime: "24m",
                symbol: "calendar.badge.exclamationmark",
                actionLabel: "Review"
            ),
            InboxItem(
                id: UUID(uuidString: "30000000-0000-0000-0000-000000000003")!,
                category: .activity,
                tone: .receipt,
                title: "Morning state refreshed",
                summary: "Compact project and task projections were rebuilt from canonical sources.",
                relativeTime: "1h",
                symbol: "checkmark.seal",
                actionLabel: nil
            ),
            InboxItem(
                id: UUID(uuidString: "30000000-0000-0000-0000-000000000004")!,
                category: .activity,
                tone: .update,
                title: "Calendar ingestion complete",
                summary: "Three changed events were normalized. No external events were modified.",
                relativeTime: "2h",
                symbol: "arrow.triangle.2.circlepath",
                actionLabel: nil
            ),
            InboxItem(
                id: UUID(uuidString: "30000000-0000-0000-0000-000000000005")!,
                category: .approvals,
                tone: .proposal,
                title: "Task proposal ready",
                summary: "A reviewed commitment can become a task after exact-source validation.",
                relativeTime: "35m",
                symbol: "checkmark.shield",
                actionLabel: "Inspect"
            )
        ],
        tasks: [
            LifeTask(
                id: UUID(uuidString: "20000000-0000-0000-0000-000000000001")!,
                title: "Draft the iPhone prototype brief",
                project: "LifeOS",
                dueLabel: "Today",
                priority: .high,
                isComplete: false
            ),
            LifeTask(
                id: UUID(uuidString: "20000000-0000-0000-0000-000000000002")!,
                title: "Review quarterly goals",
                project: "Personal planning",
                dueLabel: "Today",
                priority: .normal,
                isComplete: false
            ),
            LifeTask(
                id: UUID(uuidString: "20000000-0000-0000-0000-000000000003")!,
                title: "Collect feedback on inbox language",
                project: "LifeOS",
                dueLabel: "Tomorrow",
                priority: .normal,
                isComplete: false
            ),
            LifeTask(
                id: UUID(uuidString: "20000000-0000-0000-0000-000000000004")!,
                title: "Archive completed project notes",
                project: "Personal planning",
                dueLabel: nil,
                priority: .low,
                isComplete: true
            )
        ],
        taskDetails: [
            TaskDetail(
                taskID: UUID(uuidString: "20000000-0000-0000-0000-000000000001")!,
                summary: "Shape the first native LifeOS experience around the moments when a phone is most useful: orienting the day, reviewing decisions, and checking the next action.",
                intendedOutcome: "A testable iPhone prototype with a clear information hierarchy and no direct access to canonical storage.",
                nextStep: "Write the read-only task-detail response contract after the interaction design is accepted.",
                progress: 0.65,
                vaultContext: [
                    TaskContextItem(
                        id: UUID(uuidString: "40000000-0000-0000-0000-000000000001")!,
                        sourceLabel: "Project note",
                        title: "LifeOS mobile direction",
                        summary: "The mobile client should surface compact state and reviewed decisions while preserving server-side policy boundaries.",
                        updatedLabel: "Updated today",
                        symbol: "doc.text"
                    ),
                    TaskContextItem(
                        id: UUID(uuidString: "40000000-0000-0000-0000-000000000002")!,
                        sourceLabel: "Recent decision",
                        title: "Prototype with mock projections first",
                        summary: "Validate navigation and presentation before creating a connected API or authentication flow.",
                        updatedLabel: "Decided today",
                        symbol: "checkmark.seal"
                    )
                ],
                agentCommentary: AgentCommentary(
                    headline: "The interface is ready for a contract spike",
                    body: "The core navigation now communicates the product shape. The highest-leverage next move is to define exactly which sanitized task fields the phone needs, without exposing vault paths or raw excerpts.",
                    suggestions: [
                        "Keep the first endpoint read-only.",
                        "Separate source-derived facts from generated guidance.",
                        "Include provenance and freshness without exposing source hashes."
                    ],
                    generatedLabel: "Fabricated preview commentary"
                )
            ),
            TaskDetail(
                taskID: UUID(uuidString: "20000000-0000-0000-0000-000000000002")!,
                summary: "Review the current goals against active projects and decide what deserves attention this quarter.",
                intendedOutcome: "A shorter, credible set of goals connected to work already in motion.",
                nextStep: "Compare each goal with the current project list and flag anything without an active next action.",
                progress: 0.25,
                vaultContext: [
                    TaskContextItem(
                        id: UUID(uuidString: "40000000-0000-0000-0000-000000000003")!,
                        sourceLabel: "Planning note",
                        title: "Quarterly goals",
                        summary: "The review emphasizes fewer commitments, explicit tradeoffs, and weekly evidence of progress.",
                        updatedLabel: "Updated this week",
                        symbol: "target"
                    )
                ],
                agentCommentary: AgentCommentary(
                    headline: "Look for goals that have become obligations",
                    body: "One useful test is whether each goal still represents a chosen direction or has quietly turned into maintenance work.",
                    suggestions: ["Keep, revise, or retire each goal.", "Name the cost of keeping every goal."],
                    generatedLabel: "Fabricated preview commentary"
                )
            ),
            TaskDetail(
                taskID: UUID(uuidString: "20000000-0000-0000-0000-000000000003")!,
                summary: "Collect concrete reactions to the language used for clarifications, receipts, and approvals in the LifeOS inbox.",
                intendedOutcome: "Notification language that makes autonomy and required user action immediately understandable.",
                nextStep: "Choose five representative inbox cards and ask testers what they believe will happen next.",
                progress: 0.4,
                vaultContext: [
                    TaskContextItem(
                        id: UUID(uuidString: "40000000-0000-0000-0000-000000000004")!,
                        sourceLabel: "Design note",
                        title: "Inbox vocabulary",
                        summary: "Receipts, questions, and proposals must remain visually distinct and describe their lifecycle accurately.",
                        updatedLabel: "Updated yesterday",
                        symbol: "text.bubble"
                    )
                ],
                agentCommentary: nil
            ),
            TaskDetail(
                taskID: UUID(uuidString: "20000000-0000-0000-0000-000000000004")!,
                summary: "Move finished project material out of active planning views while preserving canonical notes and provenance.",
                intendedOutcome: "Cleaner active-project views with completed material still discoverable.",
                nextStep: "No next action—the task is complete.",
                progress: 1,
                vaultContext: [
                    TaskContextItem(
                        id: UUID(uuidString: "40000000-0000-0000-0000-000000000005")!,
                        sourceLabel: "Activity receipt",
                        title: "Project notes archived",
                        summary: "The organizational change completed successfully and retained canonical source identity.",
                        updatedLabel: "Completed this week",
                        symbol: "archivebox"
                    )
                ],
                agentCommentary: nil
            )
        ],
        systemStatus: SystemStatus(
            isConnected: false,
            isReadOnly: true,
            lastSync: "Preview data",
            enabledSources: ["Obsidian", "Calendar", "Gmail", "Messages"]
        )
    )
}
