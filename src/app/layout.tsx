import "@/lib/boot";
import "./globals.css";

export const metadata = {
  title: "FreelanceOS",
  description:
    "Freelance opportunity and revenue operating system",
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
