import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { requireAuth } from '../../middleware/requireAuth';
import * as authController from './auth.controller';

export const authRouter = Router();

// Public: these are how a caller obtains a token in the first place.
authRouter.post('/signup', asyncHandler(authController.signup));
authRouter.post('/login', asyncHandler(authController.login));

// Protected.
authRouter.get('/me', requireAuth, asyncHandler(authController.me));
