/** Toàn bộ chữ hiển thị (tiếng Việt). Không viết chữ Việt cứng trong .tsx (test `strings.test.ts`). */
export const strings = {
  appName: "radard",
  login: {
    prompt: "Đăng nhập để tiếp tục.",
    with: (provider: string) => `Đăng nhập bằng ${provider}`,
    noProvider: "Chưa bật cách đăng nhập nào.",
    unavailable: "Chưa đăng nhập được lúc này. Hãy thử lại sau.",
    failed: "Đăng nhập không thành công. Hãy thử lại.",
    errors: {
      invite_required: "Email này chưa được mời dùng radard.",
    } as Record<string, string>,
  },
  home: {
    hello: (name: string) => `Xin chào, ${name}.`,
    signOut: "Đăng xuất",
  },
  noProfile: "Tài khoản này chưa có hồ sơ. Hãy liên hệ người quản lý radard.",
  genericError: "Có lỗi xảy ra. Hãy tải lại trang.",
  providerNames: { github: "GitHub", google: "Google" } as Record<string, string>,
};
