// The subset of web-push (MIT) Talaria uses: VAPID key generation and signed, aes128gcm-encrypted request details.
declare module 'web-push' {
  interface RequestDetails { method: string; headers: Record<string, string | number>; body: Buffer | null; endpoint: string }
  interface RequestOptions {
    vapidDetails: { subject: string; publicKey: string; privateKey: string }
    TTL: number
    urgency: 'very-low' | 'low' | 'normal' | 'high'
    contentEncoding: 'aes128gcm'
  }
  const webpush: {
    generateVAPIDKeys(): { publicKey: string; privateKey: string }
    generateRequestDetails(subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string, options: RequestOptions): RequestDetails
  }
  export default webpush
}
