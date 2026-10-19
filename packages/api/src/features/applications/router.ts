import { aiRouter } from "./ai";
import { captureRouter, queueRouter } from "./capture-router";
import { crudRouter } from "./crud";

export const applicationsRouter = {
	capture: captureRouter,
	queue: queueRouter,
	list: crudRouter.list,
	getById: crudRouter.getById,
	create: crudRouter.create,
	import: crudRouter.import,
	update: crudRouter.update,
	attachDocument: crudRouter.attachDocument,
	removeDocument: crudRouter.removeDocument,
	addNote: crudRouter.addNote,
	addInterview: crudRouter.addInterview,
	updateInterview: crudRouter.updateInterview,
	updateTimelineEntry: crudRouter.updateTimelineEntry,
	deleteTimelineEntry: crudRouter.deleteTimelineEntry,
	delete: crudRouter.delete,
	bulkUpdate: crudRouter.bulkUpdate,
	bulkDelete: crudRouter.bulkDelete,
	stats: crudRouter.stats,
	tags: crudRouter.tags,
	ai: aiRouter,
};

