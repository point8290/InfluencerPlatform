import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { listCurrencies } from './currency.service';

export const currencyRouter = Router();

/**
 * Public. This is seeded platform configuration — prices and plans the
 * platform advertises — not user data, so it carries no auth requirement.
 * The signup screen can show prices before anyone has an account.
 */
currencyRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await listCurrencies());
  }),
);
