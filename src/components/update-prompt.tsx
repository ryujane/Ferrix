import { Scroll, Text, View } from "nsh";
import type { AppUpdates } from "../data/app-updates";
import { t } from "../i18n";
import { Action } from "./action";
import { Modal } from "./modal";

export function UpdateStatus(props: { updates: AppUpdates; testID?: string }) {
  const state = props.updates.state;
  function status() {
    const value = state();
    if (value.phase === "downloading" && value.progress !== undefined)
      return t("updates.downloadProgress", { progress: value.progress });
    if (value.phase === "available" && value.update.kind === "package")
      return t("updates.packageAvailable", {
        version: value.update.version,
        build: value.update.build,
      });
    if (value.phase === "downloaded" && value.update.kind === "package")
      return t("updates.packageDownloaded", { version: value.update.version });
    if (value.phase === "available" && !value.update.canInstall)
      return t("updates.manualAvailable", { version: value.update.version });
    return t(`updates.${value.phase}`, {
      version: "update" in value ? value.update.version : undefined,
    });
  }
  return (
    <Text
      testID={props.testID}
      class={`text-(--text-size-12)/(--line-height-16) ${state().phase.endsWith("Failed") ? "text-destructive" : "text-muted-foreground"}`}
    >
      {status()}
    </Text>
  );
}

export function UpdateNotes(props: { updates: AppUpdates }) {
  const notes = () => {
    const value = props.updates.state();
    return "update" in value ? value.update.notes?.slice(0, 2000) : undefined;
  };
  return (
    <If when={notes()}>
      <Text class="text-(--text-size-12) text-muted-foreground leading-(--line-height-21)">
        {notes()}
      </Text>
    </If>
  );
}

export function UpdateActions(props: { updates: AppUpdates; id: string }) {
  const state = props.updates.state;
  function applyLabel() {
    const value = state();
    if (!("update" in value) || !value.update.canInstall)
      return t("updates.openRelease");
    return t(
      value.phase === "downloaded" || value.phase === "installFailed"
        ? "updates.restart"
        : "updates.install",
    );
  }
  return (
    <>
      <If when={props.updates.canSkip()}>
        <Action
          testID={`${props.id}-skip-update`}
          label={t("updates.skip")}
          onPress={() => void props.updates.skip()}
        />
      </If>
      <If when={state().phase === "downloadFailed" || state().phase === "downloadAndOpenFailed"}>
        <Action
          testID={`${props.id}-open-release`}
          label={t("updates.openRelease")}
          onPress={() => void props.updates.openRelease()}
        />
      </If>
      <If when={props.updates.canApply()}>
        <Action
          testID={`${props.id}-apply-update`}
          label={applyLabel()}
          icon="download"
          primary
          onPress={() => void props.updates.apply()}
        />
      </If>
    </>
  );
}

export function UpdatePrompt(props: { updates: AppUpdates }) {
  return (
    <Modal
      id="startup-update"
      title={t("updates.title")}
      width={540}
      height="auto"
      maxHeight={480}
      headerHeight={56}
      onClose={props.updates.dismissPrompt}
    >
      <View class="min-h-0 shrink gap-3 px-8 pb-5">
        <Scroll testID="startup-update-copy" class="min-h-0 shrink" contentClass="gap-3">
          <UpdateStatus updates={props.updates} testID="startup-update-status" />
          <UpdateNotes updates={props.updates} />
        </Scroll>
        <View class="shrink-0 flex-row flex-wrap justify-end items-center gap-2">
          <Action
            testID="startup-update-later"
            label={t("updates.later")}
            onPress={props.updates.dismissPrompt}
          />
          <UpdateActions updates={props.updates} id="startup" />
        </View>
      </View>
    </Modal>
  );
}
