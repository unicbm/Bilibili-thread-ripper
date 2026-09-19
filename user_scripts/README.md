# 油猴脚本

装好 [Tampermonkey](https://www.tampermonkey.net/)，禁用原版脚本，然后点：[**安装 unicbm 自用修复版 0.9.2.1**](https://raw.githubusercontent.com/unicbm/Bilibili-thread-ripper/main/user_scripts/bilibili-thread-ripper.user.js)。安装后刷新 B 站页面。

本版具有独立名称和 namespace，自动更新只跟随 unicbm 的 fork。原有站点设置继续沿用。仅修复失败请求清理、签名地址刷新和交付前校验，保留上游的加速策略。

设置：点油猴图标 → 线程撕裂者设置

- `bilibili-thread-ripper.user.js`：脚本本体，由 `scripts/build-userscript.ps1` 生成，别手改
- `adapter/`：让扩展代码能在油猴里跑的两个小文件（存设置、启动）。设置面板和扩展是同一份代码
