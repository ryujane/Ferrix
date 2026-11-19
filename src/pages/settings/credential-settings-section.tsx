import { cleanup, effect, signal, Text, View } from "nsh";
import { Action } from "../../components/action";
import { Dot } from "../../components/dot";
import { Field, ErrorText, Segments } from "../../components/form-controls";
import { safeError } from "../../utils/errors";
import { t } from "../../i18n";
import type {
  CredentialConfiguration,
  CredentialProvider,
} from "../../data/credential-settings";
const ct = (key: string) => t(`credentials.${key}`);
export function CredentialSettingsSection(props: {
  state: CredentialConfiguration;
}) {
  const state = props.state,
    choice = signal<CredentialProvider>(state.status().provider),
    edited = signal(false),
    changing = signal(false);
  const master = signal(""),
    confirmation = signal(""),
    current = signal(""),
    next = signal(""),
    nextConfirmation = signal(""),
    localError = signal("");
  const clear = () => {
    master.set("");
    confirmation.set("");
    current.set("");
    next.set("");
    nextConfirmation.set("");
  };
  cleanup(clear);
  effect(() => {
    const saved = state.status().provider;
    if (!edited()) choice.set(saved);
  });
  const pending = () => choice() !== state.status().provider;
  async function apply() {
    localError.set("");
    if (
      choice() === "keepass" &&
      !state.status().keepassExists &&
      master() !== confirmation()
    ) {
      localError.set(ct("mismatch"));
      return;
    }
    const ok =
      choice() === "keepass"
        ? await state.useKeePass(master(), confirmation())
        : await state.useNative(master() || undefined);
    clear();
    if (ok) {
      edited.set(false);
      changing.set(false);
    }
  }
  async function unlock() {
    localError.set("");
    await state.unlock(master());
    master.set("");
  }
  async function changeMaster() {
    localError.set("");
    if (next() !== nextConfirmation()) {
      localError.set(ct("mismatch"));
      return;
    }
    const ok = await state.changeMaster(current(), next(), nextConfirmation());
    clear();
    if (ok) changing.set(false);
  }
  return (
    <View testID="credential-settings" class="gap-4 py-2">
      <View class="flex-row items-center gap-2">
        <Dot />
        <Text class="text-(--text-size-12)/(--line-height-16) text-muted-foreground">
          {ct("current")} ·{" "}
          {state.status().provider === "native" ? "Native Keychain" : "KeePass"}
        </Text>
        <View class="flex-1" />
        <Text testID="credential-status" class="text-(--text-size-11) text-faint">
          {ct(
            state.busy()
              ? "working"
              : state.loading()
                ? "loading"
                : state.status().provider === "native"
                  ? "systemManaged"
                  : state.status().keepassUnlocked
                    ? "unlocked"
                    : "locked",
          )}
        </Text>
      </View>
      <Segments
        id="credential-provider"
        disabled={state.busy()}
        value={choice()}
        items={[
          { value: "native", title: "Native Keychain" },
          { value: "keepass", title: "KeePass" },
        ]}
        onChange={(value) => {
          choice.set(value as CredentialProvider);
          edited.set(true);
          changing.set(false);
          localError.set("");
          clear();
        }}
      />
      <If
        when={choice() === "keepass"}
        else={
          <Text class="text-(--text-size-12) leading-(--line-height-19) text-muted-foreground">
            {ct("nativeDescription")}
          </Text>
        }
      >
        <Text class="text-(--text-size-12) leading-(--line-height-19) text-muted-foreground">
          {ct("keepassDescription")}
        </Text>
        <View class="gap-1">
          <Text class="text-(--text-size-11) text-faint">{ct("file")}</Text>
          <View
            selectable
            class="rounded-md border border-border bg-workspace p-3"
          >
            <Text class="text-(--text-size-11) font-mono text-muted-foreground">
              {state.status().filePath || "datadir/credentials.kdbx"}
            </Text>
          </View>
        </View>
        <Text class="text-(--text-size-11) leading-(--line-height-18) text-faint">
          {ct("masterHint")}
        </Text>
      </If>
      <If when={pending()}>
        <If
          when={choice() === "keepass"}
          else={
            <If when={!state.status().keepassUnlocked}>
              <Field
                id="credential-master"
                label={ct("currentPassword")}
                password
                value={master()}
                onChange={master.set}
                maxLength={1024}
                disabled={state.busy()}
              />
            </If>
          }
        >
          <Field
            id="credential-master"
            label={ct(
              state.status().keepassExists ? "masterPassword" : "newPassword",
            )}
            password
            value={master()}
            onChange={master.set}
            maxLength={1024}
            disabled={state.busy()}
          />
          <If when={!state.status().keepassExists}>
            <Field
              id="credential-confirm"
              label={ct("confirmPassword")}
              password
              value={confirmation()}
              onChange={confirmation.set}
              maxLength={1024}
              disabled={state.busy()}
            />
          </If>
        </If>
        <View class="flex-row flex-wrap items-center gap-3">
          <Text class="flex-1 text-(--text-size-11) leading-(--line-height-18) text-faint">
            {ct("migrationHint")}
          </Text>
          <Action
            testID="credential-apply"
            label={ct(state.busy() ? "working" : "apply")}
            primary
            disabled={state.busy() || !state.available()}
            onPress={() => void apply()}
          />
        </View>
      </If>
      <If when={!pending() && state.status().provider === "keepass"}>
        <If
          when={!state.status().keepassUnlocked}
          else={
            <View class="flex-row gap-2">
              <Action
                testID="credential-lock"
                label={ct("lock")}
                disabled={state.busy()}
                onPress={() => {
                  clear();
                  changing.set(false);
                  void state.lock();
                }}
              />
              <Action
                testID="credential-change-master"
                label={ct("changeMaster")}
                disabled={state.busy()}
                onPress={() => {
                  changing.set(!changing());
                  clear();
                  localError.set("");
                }}
              />
            </View>
          }
        >
          <Field
            id="credential-unlock-password"
            label={ct("masterPassword")}
            password
            value={master()}
            onChange={master.set}
            maxLength={1024}
            disabled={state.busy()}
          />
          <View class="flex-row justify-end">
            <Action
              testID="credential-unlock"
              label={ct(state.busy() ? "working" : "unlock")}
              primary
              disabled={state.busy() || !master()}
              onPress={() => void unlock()}
            />
          </View>
        </If>
        <If when={changing() && state.status().keepassUnlocked}>
          <View class="pt-4 gap-4 border-t border-border">
            <Text class="text-(--text-size-14)/(--line-height-20) font-semibold text-foreground">
              {ct("changeMaster")}
            </Text>
            <Field
              id="credential-current-password"
              label={ct("currentPassword")}
              password
              value={current()}
              onChange={current.set}
              maxLength={1024}
              disabled={state.busy()}
            />
            <Field
              id="credential-new-password"
              label={ct("newPassword")}
              password
              value={next()}
              onChange={next.set}
              maxLength={1024}
              disabled={state.busy()}
            />
            <Field
              id="credential-new-confirm"
              label={ct("confirmPassword")}
              password
              value={nextConfirmation()}
              onChange={nextConfirmation.set}
              maxLength={1024}
              disabled={state.busy()}
            />
            <View class="flex-row justify-end gap-2">
              <Action
                label={ct("cancel")}
                disabled={state.busy()}
                onPress={() => {
                  changing.set(false);
                  clear();
                }}
              />
              <Action
                testID="credential-save-password"
                label={ct(state.busy() ? "working" : "savePassword")}
                primary
                disabled={state.busy()}
                onPress={() => void changeMaster()}
              />
            </View>
          </View>
        </If>
        <Text class="text-(--text-size-11) text-faint">{ct("sessionHint")}</Text>
      </If>
      <ErrorText
        message={
          localError() || (state.error() ? safeError(state.error()) : "")
        }
      />
      <If when={!!state.message() && !state.error() && !localError()}>
        <Text testID="credential-notice" class="text-(--text-size-12)/(--line-height-16) text-success">
          {ct(state.message())}
        </Text>
      </If>
      <View class="flex-row items-center gap-3">
        <Text class="flex-1 text-(--text-size-11) leading-(--line-height-18) text-faint">
          {ct("separateHint")}
        </Text>
        <Action
          testID="credential-refresh"
          label={ct("refresh")}
          compact
          disabled={state.busy() || state.loading()}
          onPress={() => void state.refresh()}
        />
      </View>
    </View>
  );
}
