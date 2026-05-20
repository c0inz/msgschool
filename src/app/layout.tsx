import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MsgSchool — Your Canvas & Skyward agent, 24/7",
  description:
    "Message @MsgSchoolBot on Telegram. Your own AI agent, monitoring Canvas and Skyward around the clock.",
  openGraph: {
    title: "MsgSchool",
    description: "Your own Canvas & Skyward agent, 24/7 on Telegram.",
    url: "https://msgschool.com",
    siteName: "MsgSchool",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
