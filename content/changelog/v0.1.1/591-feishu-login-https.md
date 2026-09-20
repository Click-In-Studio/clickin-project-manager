---
kind: fixed
title: 飞书登录不再在中途被挡下
page: start/login/register-and-login
pr: 592
---

用飞书登录时，从飞书跳回 Backstage 这一步不再走一段不加密的地址；部分浏览器和飞书内置浏览器里原来会在这一步被拦住，现在能直接进来。邮箱登录邮件里的链接也一并改成加密地址。
