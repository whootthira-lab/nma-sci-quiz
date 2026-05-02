import type { Metadata } from 'next';
import { AuthProvider } from '@/lib/auth-context';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Video Studio — แพลตฟอร์มสร้างวิดีโอ AI สำหรับครู',
  description: 'สร้างวิดีโอการสอนด้วย AI อย่างมืออาชีพ ด้วยเทคโนโลยี Text-to-Video และ Face Motion',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="th" className="dark">
      <body className="min-h-screen bg-surface-0 font-body antialiased">
        <AuthProvider>
          <div className="min-h-screen bg-grid-pattern">
            {children}
          </div>
        </AuthProvider>
      </body>
    </html>
  );
}
