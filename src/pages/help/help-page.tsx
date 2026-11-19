import { appInfo, openUrl, Scroll, signal, Text, token, View } from "nsh";
import { Button } from "nsh/base";
import { runningPackage } from "nsh/updater";
import { Icon, type IconName } from "../../components/icon";
import { Action } from "../../components/action";
import { UpdateActions, UpdateNotes, UpdateStatus } from "../../components/update-prompt";
import type { AppUpdates } from "../../data/app-updates";
import { projectLinks } from "../../data/project-links";
import { releaseHighlights } from "./help-content";
import { t } from "../../i18n";
import { Logo } from "../../components/logo";

function ProjectLink(props: {
  id: string;
  title: string;
  icon: IconName;
  onOpen: () => void;
}) {
  return (
    <View class="flex-row items-center gap-1 border-b border-border/50 py-1">
      <Button
        testID={`help-${props.id}`}
        accessibilityLabel={t("help.openLink", { name: props.title })}
        onPress={props.onOpen}
        class="flex-1 min-w-0 flex-row items-center gap-3 rounded-md px-2 py-3 hover:bg-accent active:opacity-70 focus:ring-1 focus:ring-ring"
      >
        <Icon name={props.icon} size={18} color={token("foreground")} />
        <Text class="flex-1 min-w-0 text-(--text-size-13) font-medium text-foreground">
          {props.title}
        </Text>
        <Text class="text-(--text-size-16)/(--line-height-24) text-muted-foreground">↗</Text>
      </Button>
    </View>
  );
}

function UpdateSection(props: { updates: AppUpdates }) {
  return (
    <View class="gap-3 border-b border-border pb-7">
      <View class="flex-row flex-wrap items-center gap-3">
        <View class="flex-1 min-w-[185px] gap-1">
          <Text class="text-(--text-size-16)/(--line-height-24) font-semibold text-foreground">
            {t("updates.title")}
          </Text>
          <UpdateStatus updates={props.updates} testID="help-update-status" />
        </View>
        <Action
          testID="help-check-updates"
          label={t("updates.check")}
          disabled={!props.updates.canCheck()}
          onPress={() => void props.updates.check()}
        />
        <UpdateActions updates={props.updates} id="help" />
      </View>
      <UpdateNotes updates={props.updates} />
    </View>
  );
}

export function HelpPage(props: { updates: AppUpdates }) {
  const info = appInfo();
  const running = runningPackage();
  const version = running?.version ?? info.version;
  const openError = signal(false);

  async function visit(url: string) {
    openError.set(false);
    try {
      if (!(await openUrl(url)).opened) openError.set(true);
    } catch {
      openError.set(true);
    }
  }

  return (
    <View testID="help-page" class="flex-1 min-w-0 min-h-0 bg-workspace">
      <View class="h-12 shrink-0 flex-row items-center gap-3 border-b border-border px-4">
        <Icon name="help" size={18} color={token("primary")} />
        <Text class="text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">
          {t("help.title")}
        </Text>
      </View>
      {openError() && (
        <View class="shrink-0 border-b border-border bg-destructive/10 px-4 py-2">
          <Text testID="help-notice" class="text-(--text-size-12)/(--line-height-16) text-destructive">
            {t("help.openError")}
          </Text>
        </View>
      )}
      <Scroll
        testID="help-scroll"
        class="flex-1 min-h-0"
        contentClass="grow items-center p-6"
      >
        <View class="w-full max-w-[920px] gap-8 py-3 font-sans">
          <View class="flex-row items-start gap-4 border-b border-border pb-7">
            <Logo size={56} />
            <View class="flex-1 min-w-0 gap-2">
              <View class="flex-row flex-wrap items-center gap-2.5">
                <Text class="text-(--text-size-24)/(--line-height-32) font-semibold text-foreground">
                  {info.name ?? "Ferrix"}
                </Text>
                <Text
                  testID="help-version"
                  class="rounded bg-primary/10 px-2 py-1 text-(--text-size-11) font-mono text-primary"
                >
                  {version ? `v${version}` : t("help.unknownVersion")}
                </Text>
              </View>
              <Text class="text-(--text-size-13) text-muted-foreground leading-(--line-height-22)">
                {t("help.description")}
              </Text>
              <View class="flex-row flex-wrap items-center gap-x-3 gap-y-1 pt-1">
                <Text
                  testID="help-build"
                  class="text-(--text-size-11) font-mono text-muted-foreground"
                >
                  {t("help.build", { build: running?.build ?? info.build ?? "-" })}
                </Text>
                <Text
                  testID="help-channel"
                  class="text-(--text-size-11) text-muted-foreground"
                >
                  {t(info.development ? "help.development" : "help.release")}
                </Text>
              </View>
            </View>
          </View>

          <UpdateSection updates={props.updates} />

          <View class="flex-row flex-wrap gap-8">
            <View class="min-w-0 grow basis-[300px] gap-3">
              <Text class="text-(--text-size-16)/(--line-height-24) font-semibold text-foreground">
                {t("help.projectLinks")}
              </Text>
              <View>
                {(["repository", "issues"] as const).map((id) => (
                  <ProjectLink
                    id={id}
                    title={t(`help.${id}`)}
                    icon={id === "repository" ? "network" : "help"}
                    onOpen={() => {
                      void visit(projectLinks[id]);
                    }}
                  />
                ))}
              </View>
              <Text class="text-(--text-size-12) text-muted-foreground leading-(--line-height-21)">
                {t("help.feedbackHint")}
              </Text>
            </View>

            <View class="min-w-0 grow basis-[420px] gap-5">
              <View class="flex-row flex-wrap items-center justify-between gap-2">
                <Text class="text-(--text-size-16)/(--line-height-24) font-semibold text-foreground">
                  {t("help.changelog")}
                </Text>
                <Text class="text-(--text-size-11) text-muted-foreground">
                  {t("help.thisVersion")}
                </Text>
              </View>
              <View class="gap-5">
                {releaseHighlights.map((change) => (
                  <View class="gap-1.5">
                    <View class="flex-row items-center gap-2">
                      <View class="h-1 w-1 shrink-0 rounded-full bg-primary" />
                      <Text class="text-(--text-size-13) font-medium text-foreground">
                        {t(`help.changes.${change}.title`)}
                      </Text>
                    </View>
                    <Text class="pl-3 text-(--text-size-12) text-muted-foreground leading-(--line-height-21)">
                      {t(`help.changes.${change}.description`)}
                    </Text>
                  </View>
                ))}
              </View>
              <Button
                testID="help-history"
                accessibilityLabel={t("help.viewHistory")}
                onPress={() => {
                  void visit(projectLinks.history);
                }}
                class="self-start min-h-10 flex-row items-center gap-2 rounded-md px-2 hover:bg-accent active:opacity-70 focus:ring-1 focus:ring-ring"
              >
                <Text class="text-(--text-size-12)/(--line-height-16) text-primary">
                  {t("help.viewHistory")}
                </Text>
                <Text class="text-(--text-size-14)/(--line-height-20) text-primary">↗</Text>
              </Button>
            </View>
          </View>
        </View>
      </Scroll>
    </View>
  );
}
