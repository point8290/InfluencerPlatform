import type { Request, Response } from 'express';
import { authenticatedUserId } from '../../middleware/requireAuth';
import * as authService from './auth.service';

/**
 * Controllers stay thin: read the request, call the service, shape the
 * response. All validation and every rule lives in the service, so the same
 * logic is reachable from tests without going through HTTP.
 */

export async function signup(req: Request, res: Response): Promise<void> {
  const result = await authService.signup(req.body);
  res.status(201).json(result);
}

export async function login(req: Request, res: Response): Promise<void> {
  const result = await authService.login(req.body);
  res.status(200).json(result);
}

export async function me(req: Request, res: Response): Promise<void> {
  const user = await authService.getCurrentUser(authenticatedUserId(req));
  res.status(200).json({ user });
}
