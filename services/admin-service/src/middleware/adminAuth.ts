import type { MiddlewareHandler } from 'hono';

export const adminAuth: MiddlewareHandler = async (c, next) => {
  const adminKey = c.req.header('X-Admin-Key');
  if (adminKey !== process.env.ADMIN_API_KEY) {
    return c.json({ error: 'UNAUTHORIZED' }, 401);
  }
  await next();
};
