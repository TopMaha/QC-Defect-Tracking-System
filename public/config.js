/* ตั้งค่าปลายทาง API ของระบบ
 * - ปล่อยว่าง ("")  = โหมดสาธิต (Demo) ทำงานในเครื่อง ไม่ต้องมี backend
 * - ใส่ URL Worker  = ใช้งานจริง เช่น "https://qc-defect.<subdomain>.workers.dev"
 *   (ถ้า deploy หน้าเว็บไว้บน Worker เดียวกัน ให้ใส่ "" หรือ location.origin ก็ได้)
 */
window.QC_CONFIG = {
  apiBase: ""
};
