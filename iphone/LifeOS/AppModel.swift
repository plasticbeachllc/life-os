import Foundation
import Observation

@Observable
final class AppModel {
    var selectedTab: AppTab = .today
    var inboxFilter: InboxFilter = .forYou
    var taskSearch = ""

    let briefing: DailyBriefing
    let inboxItems: [InboxItem]
    let tasks: [LifeTask]
    let taskDetails: [UUID: TaskDetail]
    let systemStatus: SystemStatus

    init(
        briefing: DailyBriefing,
        inboxItems: [InboxItem],
        tasks: [LifeTask],
        taskDetails: [TaskDetail],
        systemStatus: SystemStatus
    ) {
        self.briefing = briefing
        self.inboxItems = inboxItems
        self.tasks = tasks
        self.taskDetails = Dictionary(uniqueKeysWithValues: taskDetails.map { ($0.taskID, $0) })
        self.systemStatus = systemStatus
    }

    var filteredInboxItems: [InboxItem] {
        inboxItems.filter { $0.category == inboxFilter }
    }

    var filteredTasks: [LifeTask] {
        guard !taskSearch.isEmpty else { return tasks }

        return tasks.filter {
            $0.title.localizedStandardContains(taskSearch)
                || $0.project.localizedStandardContains(taskSearch)
        }
    }

    func detail(for task: LifeTask) -> TaskDetail? {
        taskDetails[task.id]
    }
}
