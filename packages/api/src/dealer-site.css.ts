// Approved dealer-site mockup styles, with mobile navigation and form accessibility.
export const siteCss = `
*{box-sizing:border-box;margin:0}body{font-family:Inter,system-ui,sans-serif;color:#14232e;background:#fff}
a{color:inherit;text-decoration:none}
.hd{display:flex;align-items:center;gap:26px;padding:14px 28px;border-bottom:1px solid #e4eaf0;position:sticky;top:0;background:#fff;z-index:5}
.logo{font-size:21px;font-weight:800}.logo span{color:var(--primary)}
nav{display:flex;gap:20px;font-size:14.5px;font-weight:600;color:#43586c}nav a.on{color:#14232e}
.phone{margin-left:auto;font-weight:800;font-size:15.5px}
.hero{padding:44px 28px 8px;max-width:1180px;margin:0 auto}
.hero h1{font-size:38px;letter-spacing:-.02em;line-height:1.08}
.hero p{color:#5a7186;font-size:16.5px;margin-top:10px;max-width:560px}
.search{display:flex;gap:8px;margin-top:20px;max-width:620px}
.search input{flex:1;padding:12px 14px;border:1px solid #c9d5df;border-radius:10px;font-size:15px}
.btn{background:var(--primary);color:#fff;border:0;border-radius:10px;padding:12px 20px;font-weight:700;font-size:15px;cursor:pointer}
.sec{max-width:1180px;margin:0 auto;padding:28px}
.sec h2{font-size:21px;margin-bottom:14px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.card{border:1px solid #e4eaf0;border-radius:14px;overflow:hidden;background:#fff}
.ph{height:158px;display:flex;align-items:flex-end;padding:10px;color:#fff;font-size:12.5px;font-weight:700;letter-spacing:.04em}
.p1{background:linear-gradient(135deg,#33566e,#7d99ad)}.p2{background:linear-gradient(135deg,#5b4a68,#9a86ad)}.p3{background:linear-gradient(135deg,#6e3333,#ad7d7d)}.p4{background:linear-gradient(135deg,#33604a,#7dad8f)}.p5{background:linear-gradient(135deg,#555f6e,#97a3ad)}.p6{background:linear-gradient(135deg,#6e5a33,#ad9a7d)}
.cb{padding:13px 15px}.cb h3{font-size:16.5px}.cb .meta{color:#5a7186;font-size:13.5px;margin-top:3px}
.cb .row{display:flex;align-items:center;margin-top:9px}.price{font-size:18.5px;font-weight:800}
.view{margin-left:auto;font-weight:700;font-size:13.5px;color:var(--primary)}
.strip{background:#0b1f2c;color:#dbe6ee;border-radius:14px;padding:20px 22px;display:grid;grid-template-columns:repeat(3,1fr);gap:16px;max-width:1124px;margin:4px auto 0}
.strip b{color:#fff;display:block;margin-bottom:4px;font-size:15px}.strip div{font-size:13.5px;line-height:1.45}
.ft{border-top:1px solid #e4eaf0;margin-top:34px;padding:22px 28px;color:#5a7186;font-size:13.5px;display:flex;gap:34px;flex-wrap:wrap}
.ft b{color:#14232e}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
.chip{border:1px solid #c9d5df;border-radius:999px;padding:7px 13px;font-size:13.5px;font-weight:600;color:#43586c;background:#fff}
.chip.on{background:#14232e;color:#fff;border-color:#14232e}
.detail{display:grid;grid-template-columns:1.5fr 1fr;gap:22px;max-width:1180px;margin:0 auto;padding:24px 28px}
.bigph{height:340px;border-radius:14px;display:flex;align-items:flex-end;padding:14px;color:#fff;font-weight:700}
.specs{border:1px solid #e4eaf0;border-radius:14px;padding:18px}
.specs table{width:100%;border-collapse:collapse;font-size:14px;margin-top:10px}
.specs td{padding:7px 0;border-bottom:1px solid #eef2f5}.specs td:first-child{color:#5a7186;width:42%}
.lead{border:1px solid #e4eaf0;border-radius:14px;padding:18px;margin-top:16px}
.lead input,.lead textarea{width:100%;padding:10px 12px;border:1px solid #c9d5df;border-radius:9px;font-size:14.5px;margin-top:8px;font-family:inherit}
.lead .btn{width:100%;margin-top:10px}
.note{font-size:12.5px;color:#5a7186;margin-top:8px;line-height:1.45}
.page{display:none}.page.on{display:block}
@media(max-width:760px){.grid{grid-template-columns:1fr}.strip{grid-template-columns:1fr}.detail{grid-template-columns:1fr}.hero h1{font-size:29px}nav{display:none}.hd{padding:12px 16px}.sec,.hero{padding-left:16px;padding-right:16px}.detail{padding:16px}}

img{max-width:100%;object-fit:cover}.ph img,.bigph img{width:100%;height:100%;border-radius:inherit}.ph:has(img),.bigph:has(img){padding:0;overflow:hidden}.logo img{max-height:38px;max-width:160px;vertical-align:middle}.info{white-space:pre-line}.search input{min-width:0}.gallery{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.gallery img{width:120px;height:85px;border-radius:9px}label{display:block}a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid #14232e;outline-offset:3px}.success{padding:16px;background:#eaf5ee;border-radius:10px} .error{color:#a11b1b;padding:12px 0} @media(max-width:760px){.hd{flex-wrap:wrap;gap:12px}nav{display:flex;order:3;width:100%;justify-content:space-between}.phone{font-size:14px}.strip{margin:4px 16px 0}.ft{padding:22px 16px}.bigph{height:260px}}
`;
