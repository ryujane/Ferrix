import { token, View } from "nsh";

export function Dot(props: { color?: string }) {
  return (
    <View
      style={{
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: props.color ?? token("success"),
      }}
    />
  );
}
