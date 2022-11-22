import { AppCategories } from "@prisma/client";
import z from "zod";

import { appKeysSchemas } from "@calcom/app-store/apps.keys-schemas.generated";
import { getLocalAppMetadata, getAppName } from "@calcom/app-store/utils";
import { sendDisabledAppEmail } from "@calcom/emails";
import getEnabledApps from "@calcom/lib/apps/getEnabledApps";
import { deriveAppDictKeyFromType } from "@calcom/lib/deriveAppDictKeyFromType";
import { getTranslation } from "@calcom/lib/server/i18n";

import { TRPCError } from "@trpc/server";

import { router, authedProcedure } from "../../trpc";

interface FilteredApp {
  name: string;
  slug: string;
  logo: string;
  title?: string;
  type: string;
  description: string;
  keys: unknown;
  enabled: boolean;
}

export const appsRouter = router({
  listLocal: authedProcedure
    .input(
      z.object({
        variant: z.string(),
      })
    )
    .query(async ({ ctx, input }) => {
      if (ctx.session.user.role !== "ADMIN")
        throw new TRPCError({
          code: "UNAUTHORIZED",
        });

      const localApps = getLocalAppMetadata();
      const dbApps = await ctx.prisma.app.findMany({
        where: {
          categories: {
            has: input.variant === "conferencing" ? "video" : (input.variant as AppCategories),
          },
        },
        select: {
          slug: true,
          keys: true,
          enabled: true,
        },
      });

      const filteredApps: FilteredApp[] = [];

      for (const app of localApps) {
        if (app.variant === input.variant) {
          // Find app metadata
          const dbData = dbApps.find((dbApp) => dbApp.slug === app.slug);

          // If the app already contains keys then return
          if (dbData?.keys) {
            filteredApps.push({
              name: app.name,
              slug: app.slug,
              logo: app.logo,
              title: app.title,
              type: app.type,
              description: app.description,
              keys: dbData.keys,
              enabled: dbData?.enabled || false,
            });
          } else {
            const appKey = deriveAppDictKeyFromType(app.type, appKeysSchemas);
            const keysSchema = appKeysSchemas[appKey as keyof typeof appKeysSchemas] || null;
            filteredApps.push({
              name: app.name,
              slug: app.slug,
              logo: app.logo,
              type: app.type,
              title: app.title,
              description: app.description,
              enabled: dbData?.enabled || false,
              keys: keysSchema ? keysSchema.keyof()._def.values : null,
            });
          }
        }
      }
      return filteredApps;
    }),
  toggle: authedProcedure
    .input(
      z.object({
        slug: z.string(),
        enabled: z.boolean(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.session.user?.role !== "ADMIN")
        throw new TRPCError({
          code: "UNAUTHORIZED",
        });

      const { prisma } = ctx;

      const app = await prisma.app.update({
        where: {
          slug: input.slug,
        },
        data: {
          enabled: !input.enabled,
        },
      });

      // Get app name from metadata
      const localApps = getLocalAppMetadata();
      const appMetadata = localApps.find((localApp) => localApp.slug === app.slug);

      // If disabling an app then we need to alert users basesd on the app type
      if (input.enabled) {
        if (app.categories.some((category) => category === "calendar" || category === "video")) {
          const appCredentials = await prisma.credential.findMany({
            where: {
              appId: app.slug,
            },
            select: {
              user: {
                select: {
                  email: true,
                  locale: true,
                },
              },
            },
          });

          Promise.all(
            appCredentials.map(async (credential) => {
              const t = await getTranslation(credential.user?.locale || "en", "common");

              if (credential.user?.email) {
                await sendDisabledAppEmail({
                  email: credential.user.email,
                  appName: appMetadata?.name || app.slug,
                  appType: app.categories,
                  t,
                });
              }
            })
          );
        } else {
          const eventTypesWithApp = await prisma.eventType.findMany({
            where: {
              metadata: {
                path: ["apps", app.slug as string, "enabled"],
                equals: true,
              },
            },
            select: {
              id: true,
              title: true,
              users: {
                select: {
                  email: true,
                  locale: true,
                },
              },
              metadata: true,
            },
          });

          // Loop through all event types and email users to alert them that payment will be paused
          Promise.all(
            eventTypesWithApp.map(async (eventType) => {
              await prisma.eventType.update({
                where: {
                  id: eventType.id,
                },
                data: {
                  metadata: {
                    ...eventType.metadata,
                    apps: {
                      ...eventType.metadata.apps,
                      [app.slug]: { ...eventType.metadata.apps[app.slug], enabled: false },
                    },
                  },
                },
              });

              const t = await getTranslation(user.locale || "en", "common");

              eventType.users.map(async (user) => {
                await sendDisabledAppEmail(
                  eventType.title,
                  user.email,
                  appMetadata?.name,
                  appMetdata?.categories,
                  eventType.id,
                  t
                );
              });
            })
          );
        }
      }

      return app.enabled;
    }),
  saveKeys: authedProcedure
    .input(
      z.object({
        slug: z.string(),
        type: z.string(),
        // Validate w/ app specific schema
        keys: z.unknown(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.session.user.role !== "ADMIN")
        throw new TRPCError({
          code: "UNAUTHORIZED",
        });
      const appKey = deriveAppDictKeyFromType(input.type, appKeysSchemas);
      const keysSchema = appKeysSchemas[appKey as keyof typeof appKeysSchemas];

      const parse = keysSchema.parse(input.keys);

      await ctx.prisma.app.update({
        where: {
          slug: input.slug,
        },
        data: {
          keys: input.keys,
        },
      });

      return;
    }),
});