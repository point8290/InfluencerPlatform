/**
 * Adds the authenticated user id to Express's Request.
 *
 * Declared optional because it is genuinely absent on public routes. Handlers
 * behind requireAuth read it through `authenticatedUserId(req)` rather than
 * asserting with `!`, so the type system is never told something the code has
 * not actually checked.
 */
declare global {
  namespace Express {
    interface Request {
      userId?: number;
    }
  }
}

export {};
