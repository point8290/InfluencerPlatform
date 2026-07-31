import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { authenticatedUserId, requireAuth } from '../../middleware/requireAuth';
import { ValidationError } from '../../lib/errors';
import { parsePagination } from '../wallet/wallet.service';
import {
  createCampaign,
  fundCampaign,
  getCampaign,
  listCampaigns,
} from './campaign.service';

export const campaignRouter = Router();

campaignRouter.use(requireAuth);

function campaignIdFrom(raw: string | undefined): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError('Campaign id must be a positive integer.', [
      { field: 'id', message: `Received "${raw ?? ''}".` },
    ]);
  }
  return value;
}

campaignRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    res.status(201).json(await createCampaign(authenticatedUserId(req), req.body));
  }),
);

campaignRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(
      await listCampaigns(
        authenticatedUserId(req),
        parsePagination(req.query as Record<string, unknown>),
      ),
    );
  }),
);

campaignRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await getCampaign(authenticatedUserId(req), campaignIdFrom(req.params.id)));
  }),
);

campaignRouter.post(
  '/:id/fund',
  asyncHandler(async (req, res) => {
    res.json(
      await fundCampaign(authenticatedUserId(req), campaignIdFrom(req.params.id), req.body),
    );
  }),
);
