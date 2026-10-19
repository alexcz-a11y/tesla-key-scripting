# Tesla Key（Scripting 脚本）

用 iPhone 通过蓝牙充当 Tesla 车辆的**车主虚拟钥匙**，在 iOS 的 Scripting App 里运行，带主屏幕小组件。

- 只控制你自己的车：用 Tesla 官方 [vehicle-command](https://github.com/teslamotors/vehicle-command) 蓝牙协议，钥匙需要在车里用钥匙卡配对授权。
- 不经过任何服务器，不需要 Tesla 账号或 Token；私钥只存在本机钥匙串（`first_unlock_this_device`，不随 iCloud 同步）。
- 非 Tesla 官方项目，使用风险自负。

## 功能

- 解锁 / 上锁、单独弹开车门、前备箱、后备箱开关、充电口开关
- 车机（Infotainment）指令：空调、座椅加热、充电等（会唤醒车机）
- 主屏幕小组件（深色 / 浅色，支持系统「透明」「色调」外观）
  - 大号：整车状态 + 俯视图四门 + 车锁 / 前备箱 / 后备箱 / 充电口
  - 中号：车锁 / 前备箱 / 后备箱 / 充电口
  - 小号：单个部位，在小组件「参数」里填 `lock`（默认）、`door_fl`、`door_fr`、`door_rl`、`door_rr`、`trunk`、`charge`
  - 小组件只读手机上保存的状态快照，不会为了刷新而唤醒车辆；点按钮时才连车

## 安装与更新

1. 在 Scripting 里添加远程脚本，地址填：

   ```
   https://github.com/alexcz-a11y/tesla-key-scripting
   ```

   也可以固定到某个分支或标签，例如 `https://github.com/alexcz-a11y/tesla-key-scripting/tree/main`。
2. 在脚本设置里打开自动更新（检查间隔最短 30 分钟），或手动检查更新。每次发版都会递增 `script.json` 里的版本号。
3. 依赖的 npm 包（`@noble/curves`、`protobufjs`）记录在 `package.json` / `package-lock.scripting.json`。如果 App 没有自动安装，在「工具 → npm 包」里安装这两个包。

## 第一次使用

1. 运行脚本，进入「钥匙与设置」，在「车辆与 VIN」里填写车辆 VIN（17 位）。
2. 点「配对」：人在车里、钥匙卡在手边，按提示在中控刷卡并在车机屏幕上确认。
3. 配对完成后先在 App 里连一次车，再添加主屏幕小组件。

## 目录

| 路径 | 说明 |
| --- | --- |
| `index.tsx` | App 主界面入口 |
| `widget.tsx` | 主屏幕小组件 |
| `app_intents.tsx` | 小组件按钮触发的指令（先交给正在运行的主界面，不在就直连车辆） |
| `bluetooth.tsx` | 后台蓝牙任务 |
| `client/` | 车辆客户端：调度、VCSEC、车机、配对；`quick.ts` 是小组件用的轻量直连 |
| `core/` | 协议实现：会话、加密、编解码、BLE 传输；`*_lite.ts` / `pb_lite.ts` 是小组件进程能加载的轻量版本 |
| `proto/` | Tesla vehicle-command 的协议定义（Apache 2.0） |
| `ui/` | App 界面 |
| `assets/widget-r2/` | 小组件图片（3x）。图片更新时整体换到新目录 `widget-rN`，避免手机端用到旧图 |
| `tests/` | 协议测试（用 Tesla SDK 的公开测试向量） |

## Roadmap

- 接入 TeslaMate（读取行车、充电数据）
- 靠近自动解锁 / 离开自动上锁（界面开关已预留）

## 许可证

[Apache License 2.0](LICENSE)。`proto/` 下的协议文件来自 [teslamotors/vehicle-command](https://github.com/teslamotors/vehicle-command)，同为 Apache 2.0。
