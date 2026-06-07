/* ตั้งค่าปลายทาง API ของระบบ
 * - ""                = ใช้ API จาก origin เดียวกัน (กรณีเสิร์ฟหน้าเว็บจาก Worker เดียวกัน — แนะนำ)
 * - "https://..."     = ระบุ URL Worker เต็ม (กรณี host หน้าเว็บแยก เช่น GitHub Pages)
 * - "demo"            = โหมดสาธิต ทำงานในเครื่องด้วย localStorage ไม่ต้องมี backend
 *   (เปิดไฟล์ index.html ตรง ๆ แบบ file:// จะเข้าโหมดสาธิตอัตโนมัติ)
 */
window.QC_CONFIG = {
  apiBase: ""
};
