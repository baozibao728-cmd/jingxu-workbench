#!/bin/zsh
set -u
PROJECT_DIR="${0:A:h}"
DESKTOP_DIR="$HOME/Desktop"
TARGET="$PROJECT_DIR/启动工作台.command"
SHORTCUT="$DESKTOP_DIR/镜序工作台.command"
if [[ ! -x "$TARGET" ]]; then
  print "找不到启动文件：$TARGET"
  read '?按回车关闭…'
  exit 1
fi
mkdir -p "$DESKTOP_DIR"
rm -f "$SHORTCUT"
ln -s "$TARGET" "$SHORTCUT"
print "已创建桌面快捷方式：$SHORTCUT"
print "以后双击桌面的“镜序工作台.command”即可启动。"
read '?按回车关闭…'
