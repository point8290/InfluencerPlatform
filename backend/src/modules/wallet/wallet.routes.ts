import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { authenticatedUserId, requireAuth } from '../../middleware/requireAuth';
import { getLedger, getWalletBalances, parsePagination } from './wallet.service';

export const walletRouter = Router();

walletRouter.use(requireAuth);

walletRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await getWalletBalances(authenticatedUserId(req)));
  }),
);

walletRouter.get(
  '/ledger',
  asyncHandler(async (req, res) => {
    const currencyCode = typeof req.query.currency_code === 'string' ? req.query.currency_code : undefined;

    res.json(
      await getLedger(
        authenticatedUserId(req),
        currencyCode,
        parsePagination(req.query as Record<string, unknown>),
      ),
    );
  }),
);
