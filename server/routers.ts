import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { runWebsiteAudit } from "./audit";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  audit: router({
    run: publicProcedure
      .input(z.object({ url: z.string().trim().min(3).max(2048) }))
      .mutation(({ input }) => runWebsiteAudit(input.url)),
  }),
});

export type AppRouter = typeof appRouter;
