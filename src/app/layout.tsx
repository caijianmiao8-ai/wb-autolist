import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "@/components/Nav";

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
        <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-4 sm:px-6">
          <Nav />
          <main className="flex-1 pb-24 pt-10">{children}</main>
          <footer className="border-t border-slate-900/[0.06] py-7 text-center text-xs tracking-wide text-slate-400 hairline dark:text-slate-600">
            WB AutoList · 商品自动化上架工作流
          </footer>
        </div>
      </body>
    </html>
  );
}
