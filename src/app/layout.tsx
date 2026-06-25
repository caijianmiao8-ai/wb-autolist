import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/components/AppShell";

export const metadata: Metadata = {
  title: "WB AutoList · Wildberries 自动化上架",
  description:
    "输入商品名 + 关键字，AI 自动生成主图与宣传图，一键上架到 Wildberries。",
};

// Apply the saved theme before first paint (light is the default → no flash).
const themeInit = `(function(){try{if(localStorage.getItem('wb:theme')==='dark'){document.documentElement.setAttribute('data-theme','dark');}}catch(e){}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
