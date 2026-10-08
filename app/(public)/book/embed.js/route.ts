// The website embed for the online booking widget (§2.3). The clinic's site adds:
//
//   <div id="cara-booking" data-branch="" data-service=""></div>
//   <script src="https://<crm-host>/book/embed.js" async></script>
//
// and gets an iframe of /book that carries the page's UTM tags (so a booking from an
// Instagram ad is attributed to it, §3.1) and resizes itself to its content.
export const dynamic = "force-static";

const SCRIPT = `(function () {
  var script = document.currentScript;
  var origin = new URL(script.src).origin;
  var mount = document.getElementById("cara-booking");
  if (!mount) { mount = document.createElement("div"); script.parentNode.insertBefore(mount, script); }
  var page = new URLSearchParams(window.location.search);
  var q = new URLSearchParams();
  ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "gclid", "fbclid"].forEach(function (k) {
    if (page.get(k)) q.set(k, page.get(k));
  });
  if (mount.dataset.branch) q.set("branch", mount.dataset.branch);
  if (mount.dataset.service) q.set("service", mount.dataset.service);
  q.set("embed", "1");
  var frame = document.createElement("iframe");
  frame.src = origin + "/book?" + q.toString();
  frame.title = "Book an appointment";
  frame.style.cssText = "width:100%;border:0;min-height:640px;";
  frame.setAttribute("allow", "payment");
  mount.appendChild(frame);
  window.addEventListener("message", function (e) {
    if (e.origin !== origin || !e.data || e.data.type !== "cara-booking-height") return;
    frame.style.height = e.data.height + "px";
  });
})();`;

export function GET() {
  return new Response(SCRIPT, {
    headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}
