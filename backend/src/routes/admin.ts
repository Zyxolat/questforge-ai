import { Router } from 'express';
// import { requireAdminAuth } from '../middleware/auth';
// DEPRECATED: questRegistration service no longer used after lazy-registration migration
// import { registerQuestsOnchain, findUnregisteredQuests } from '../services/questRegistration';
// import { logger } from '../services/logger';

const adminRouter = Router();

/**
 * GET /admin/quests/unregistered
 * DEPRECATED: No longer used with lazy-registration architecture
 * Kept for potential backfill operations
 */
// adminRouter.get('/quests/unregistered', requireAdminAuth, async (req: Request, res: Response) => {
//   try {
//     logger.info('[ADMIN] Fetching unregistered quests');
//     const unregisteredQuestIds = await findUnregisteredQuests();
//     res.json({
//       success: true,
//       count: unregisteredQuestIds.length,
//       questIds: unregisteredQuestIds
//     });
//   } catch (error) {
//     logger.error('[ADMIN] Failed to fetch unregistered quests', {
//       error: error instanceof Error ? error.message : String(error)
//     });
//     res.status(500).json({
//       success: false,
//       error: 'Failed to fetch unregistered quests'
//     });
//   }
// });

/**
 * POST /admin/quests/register-batch
 * DEPRECATED: No longer used with lazy-registration architecture
 * Kept for potential backfill operations
 */
// adminRouter.post('/quests/register-batch', requireAdminAuth, async (req: Request, res: Response) => {
//   try {
//     let questIds = req.body.questIds as string[] | undefined;
//     const limit = Math.min(req.body.limit ?? 10, 50);
//     if (!questIds || questIds.length === 0) {
//       questIds = await findUnregisteredQuests();
//       questIds = questIds.slice(0, limit);
//     }
//     const results = await registerQuestsOnchain(questIds);
//     const successCount = results.filter((r) => r.success).length;
//     res.json({
//       success: true,
//       registered: successCount,
//       failed: results.length - successCount,
//       results: results.map((r, index) => ({
//         questId: questIds[index],
//         success: r.success,
//         chainQuestId: r.chainQuestId?.toString() ?? null,
//         error: r.error ?? null
//       }))
//     });
//   } catch (error) {
//     res.status(500).json({
//       success: false,
//       error: 'Failed to register quest batch'
//     });
//   }
// });

export { adminRouter };
