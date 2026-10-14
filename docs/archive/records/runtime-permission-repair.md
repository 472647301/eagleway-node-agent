# 早期 release 运行时目录权限修复

> 历史归档（旧 release 处理记录），归档日期：2026-10-14。
> 本文保留当时的方案或记录，可能包含过时结论及尚未实现的提案。不得作为当前项目的需求参考、实现约束或验收依据。当前说明见仓库文档索引。


旧 release 的运行时目录权限修复：

~~~bash
sudo chmod 0711 /etc/eagleway-node-agent/runtimes
sudo chmod 0711 /etc/eagleway-node-agent/runtimes/xray
sudo -u eagleway-agent test -e /etc/eagleway-node-agent/runtimes/xray/.managed-by-eagleway-node-agent && echo 'ownership marker: visible'
~~~

该操作只增加目录穿越权限；agent.env 的父目录仍限制其他用户，Xray config 和 marker 文件仍保持 0600。修复后无需重启即可重新查询 status。
