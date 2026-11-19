import { Image, token } from "nsh";
import database from "../assets/icons/database.svg";
import server from "../assets/icons/server.svg";
import search from "../assets/icons/search.svg";
import plus from "../assets/icons/plus.svg";
import settings from "../assets/icons/settings.svg";
import help from "../assets/icons/circle-help.svg";
import down from "../assets/icons/chevron-down.svg";
import right from "../assets/icons/chevron-right.svg";
import collapse from "../assets/icons/chevrons-down-up.svg";
import expand from "../assets/icons/chevrons-up-down.svg";
import folder from "../assets/icons/folder.svg";
import folderOpen from "../assets/icons/folder-open.svg";
import refresh from "../assets/icons/refresh-cw.svg";
import terminal from "../assets/icons/terminal.svg";
import network from "../assets/icons/network.svg";
import chart from "../assets/icons/chart-no-axes-combined.svg";
import save from "../assets/icons/save.svg";
import copy from "../assets/icons/copy.svg";
import trash from "../assets/icons/trash-2.svg";
import close from "../assets/icons/x.svg";
import sun from "../assets/icons/sun.svg";
import moon from "../assets/icons/moon.svg";
import sidebar from "../assets/icons/panel-left-close.svg";
import check from "../assets/icons/check.svg";
import circle from "../assets/icons/circle.svg";
import braces from "../assets/icons/braces.svg";
import filter from "../assets/icons/filter.svg";
import wrap from "../assets/icons/wrap-text.svg";
import pencil from "../assets/icons/pencil.svg";
import sliders from "../assets/icons/sliders-horizontal.svg";
import star from "../assets/icons/star.svg";
import starFilled from "../assets/icons/star-filled.svg";
import tag from "../assets/icons/tag.svg";
import ellipsis from "../assets/icons/ellipsis.svg";
import eye from "../assets/icons/eye.svg";
import eyeOff from "../assets/icons/eye-off.svg";
import shield from "../assets/icons/shield.svg";
import back from "../assets/icons/arrow-left.svg";
import key from "../assets/icons/key-round.svg";
import timer from "../assets/icons/timer.svg";
import zap from "../assets/icons/zap.svg";
import broadcast from "../assets/icons/radio-tower.svg";
import pause from "../assets/icons/pause.svg";
import play from "../assets/icons/play.svg";
import send from "../assets/icons/send.svg";
import download from "../assets/icons/arrow-down-to-line.svg";

const icons = {
  broadcast,
  pause,
  play,
  send,
  download,
  key,
  timer,
  zap,
  sliders,
  star,
  starFilled,
  tag,
  ellipsis,
  eye,
  eyeOff,
  shield,
  back,
  database,
  server,
  search,
  plus,
  settings,
  help,
  down,
  right,
  collapse,
  expand,
  folder,
  folderOpen,
  refresh,
  terminal,
  network,
  chart,
  save,
  copy,
  trash,
  close,
  sun,
  moon,
  sidebar,
  check,
  circle,
  braces,
  filter,
  wrap,
  pencil,
};
export type IconName = keyof typeof icons;
export function Icon(props: { name: IconName; size?: number; color?: string }) {
  return (
    <Image
      src={icons[props.name]}
      style={{
        width: props.size ?? 16,
        height: props.size ?? 16,
        tintColor: props.color ?? token("muted-foreground"),
      }}
    />
  );
}
