/*****************************************************************************
#                                                                            #
#    KVMD - The main PiKVM daemon.                                           #
#                                                                            #
#    Copyright (C) 2018-2024  Maxim Devaev <mdevaev@gmail.com>               #
#    Copyright (C) 2023-2025  SilentWind <mofeng654321@hotmail.com>          #
#                                                                            #
#    This program is free software: you can redistribute it and/or modify    #
#    it under the terms of the GNU General Public License as published by    #
#    the Free Software Foundation, either version 3 of the License, or       #
#    (at your option) any later version.                                     #
#                                                                            #
#    This program is distributed in the hope that it will be useful,         #
#    but WITHOUT ANY WARRANTY; without even the implied warranty of          #
#    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the           #
#    GNU General Public License for more details.                            #
#                                                                            #
#    You should have received a copy of the GNU General Public License       #
#    along with this program.  If not, see <https://www.gnu.org/licenses/>.  #
#                                                                            #
*****************************************************************************/


"use strict";


import {tools, $} from "../tools.js";
import {wm} from "../wm.js";

import {JanusStreamer} from "./stream_janus.js";
import {MediaStreamer} from "./stream_media.js";
import {MjpegStreamer} from "./stream_mjpeg.js";

import { qram, jsQR, base64url, saveUint8ArrayToFile } from "./qram-one-kvm.min.js";

export function Streamer() {
	var self = this;

	/************************************************************************/

	var __janus_imported = null;
	var __streamer = null;

	var __state = null;
	var __res = {"width": 640, "height": 480};

	var __init__ = function() {
		__streamer = new MjpegStreamer(__setActive, __setInactive, __setInfo);

		$("stream-led").title = "Stream inactive";

		tools.slider.setParams($("stream-quality-slider"), 5, 100, 5, 80, function(value) {
			$("stream-quality-value").innerText = `${value}%`;
		});
		tools.slider.setOnUpDelayed($("stream-quality-slider"), 1000, (value) => __sendParam("quality", value));

		tools.slider.setParams($("stream-h264-bitrate-slider"), 25, 20000, 25, 5000, function(value) {
			$("stream-h264-bitrate-value").innerText = value;
		});
		tools.slider.setOnUpDelayed($("stream-h264-bitrate-slider"), 1000, (value) => __sendParam("h264_bitrate", value));

		tools.slider.setParams($("stream-h264-gop-slider"), 0, 60, 1, 30, function(value) {
			$("stream-h264-gop-value").innerText = value;
		});
		tools.slider.setOnUpDelayed($("stream-h264-gop-slider"), 1000, (value) => __sendParam("h264_gop", value));

		tools.slider.setParams($("stream-desired-fps-slider"), 0, 120, 1, 0, function(value) {
			$("stream-desired-fps-value").innerText = (value === 0 ? "Unlimited" : value);
		});
		tools.slider.setOnUpDelayed($("stream-desired-fps-slider"), 1000, (value) => __sendParam("desired_fps", value));

		$("stream-resolution-selector").onchange = (() => __sendParam("resolution", $("stream-resolution-selector").value));

		tools.radio.setOnClick("stream-mode-radio", __clickModeRadio, false);

		// Not getInt() because of radio is a string container.
		// Also don't reset Janus at class init.
		tools.radio.clickValue("stream-orient-radio", tools.storage.get("stream.orient", 0));
		tools.radio.setOnClick("stream-orient-radio", function() {
			if (__streamer.getMode() === "janus") { // Right now it's working only for H.264
				let orient = parseInt(tools.radio.getValue("stream-orient-radio"));
				tools.storage.setInt("stream.orient", orient);
				if (__streamer.getOrientation() != orient) {
					__resetStream();
				}
			}
		}, false);

		tools.slider.setParams($("stream-audio-volume-slider"), 0, 100, 1, 0, function(value) {
			$("stream-video").muted = !value;
			$("stream-video").volume = value / 100;
			$("stream-audio-volume-value").innerText = value + "%";
			if (__streamer.getMode() === "janus") {
				let allow_audio = !$("stream-video").muted;
				if (__streamer.isAudioAllowed() !== allow_audio) {
					__resetStream();
				}
			}
			tools.el.setEnabled($("stream-mic-switch"), !!value);
		});

		tools.storage.bindSimpleSwitch($("stream-mic-switch"), "stream.mic", false, function(allow_mic) {
			if (__streamer.getMode() === "janus") {
				if (__streamer.isMicAllowed() !== allow_mic) {
					__resetStream();
				}
			}
		});

		tools.el.setOnClick($("stream-screenshot-button"), __clickScreenshotButton);
		tools.el.setOnClick($("stream-reset-button"), __clickResetButton);
		tools.el.setOnClick($("stream-record-start-button"), __clickRecordStartButton);
		tools.el.setOnClick($("stream-record-stop-button"), __clickRecordStopButton);
		tools.el.setOnClick($("txqr-start-button"), __clickTxqrStartButton);
		tools.el.setOnClick($("txqr-stop-button"), __clickTxqrStopButton);


		$("stream-window").show_hook = () => __applyState(__state);
		$("stream-window").close_hook = () => __applyState(null);

		//hidden stream-record-stop-button and txqr-stop-button
		document.getElementById('stream-record-stop-button').disabled = true;
		document.getElementById('txqr-stop-button').disabled = true;
	};

	/************************************************************************/

	self.ensureDeps = function(callback) {
		JanusStreamer.ensure_janus(function(avail) {
			__janus_imported = avail;
			callback();
		});
	};

	self.getGeometry = function() {
		// Первоначально обновление геометрии считалось через ResizeObserver.
		// Но оно не ловило некоторые события, например в последовательности:
		//   - Находять в HD переходим в фулскрин
		//   - Меняем разрешение на маленькое
		//   - Убираем фулскрин
		//   - Переходим в HD
		//   - Видим нарушение пропорций
		// Так что теперь используются быстре рассчеты через offset*
		// вместо getBoundingClientRect().
		let res = __streamer.getResolution();
		let ratio = Math.min(res.view_width / res.real_width, res.view_height / res.real_height);
		return {
			"x": Math.round((res.view_width - ratio * res.real_width) / 2),
			"y": Math.round((res.view_height - ratio * res.real_height) / 2),
			"width": Math.round(ratio * res.real_width),
			"height": Math.round(ratio * res.real_height),
			"real_width": res.real_width,
			"real_height": res.real_height,
		};
	};

	self.setState = function(state) {
		if (state) {
			if (!__state) {
				__state = {};
			}
			if (state.features !== undefined) {
				__state.features = state.features;
				__state.limits = state.limits; // Following together with features
			}
			if (__state.features !== undefined && state.streamer !== undefined) {
				__state.streamer = state.streamer;
				__setControlsEnabled(!!state.streamer);
			}
		} else {
			__state = null;
			__setControlsEnabled(false);
		}
		let visible = wm.isWindowVisible($("stream-window"));
		__applyState((visible && __state && __state.features) ? state : null);
	};

	var __applyState = function(state) {
		if (__janus_imported === null) {
			alert("__janus_imported is null, please report");
			return;
		}

		if (!state) {
			__streamer.stopStream();
			return;
		}

		if (state.features) {
			let f = state.features;
			let l = state.limits;
			let sup_h264 = $("stream-video").canPlayType("video/mp4; codecs=\"avc1.42E01F\"");
			let sup_vd = MediaStreamer.is_videodecoder_available();
			let sup_webrtc = JanusStreamer.is_webrtc_available();
			let has_media = (f.h264 && sup_vd); // Don't check sup_h264 for sure
			let has_janus = (__janus_imported && f.h264 && sup_webrtc); // Same

			tools.info(
				`Stream: Janus WebRTC state: features.h264=${f.h264},`
				+ ` webrtc=${sup_webrtc}, h264=${sup_h264}, janus_imported=${__janus_imported}`
			);

			tools.hidden.setVisible($("stream-message-no-webrtc"), __janus_imported && f.h264 && !sup_webrtc);
			tools.hidden.setVisible($("stream-message-no-vd"), f.h264 && !sup_vd);
			tools.hidden.setVisible($("stream-message-no-h264"), __janus_imported && f.h264 && !sup_h264);

			tools.slider.setRange($("stream-desired-fps-slider"), l.desired_fps.min, l.desired_fps.max);
			if (f.resolution) {
				let el = $("stream-resolution-selector");
				el.options.length = 0;
				for (let res of l.available_resolutions) {
					tools.selector.addOption(el, res, res);
				}
			} else {
				$("stream-resolution-selector").options.length = 0;
			}
			if (f.h264) {
				tools.slider.setRange($("stream-h264-bitrate-slider"), l.h264_bitrate.min, l.h264_bitrate.max);
				tools.slider.setRange($("stream-h264-gop-slider"), l.h264_gop.min, l.h264_gop.max);
			}

			// tools.feature.setEnabled($("stream-quality"), f.quality); // Only on s.encoder.quality
			tools.feature.setEnabled($("stream-resolution"), f.resolution);
			tools.feature.setEnabled($("stream-h264-bitrate"), f.h264);
			tools.feature.setEnabled($("stream-h264-gop"), f.h264);
			tools.feature.setEnabled($("stream-mode"), f.h264);
			if (!f.h264) {
				tools.feature.setEnabled($("stream-audio"), false);
				tools.feature.setEnabled($("stream-mic"), false);
			}

			let mode = tools.storage.get("stream.mode", "mjpeg");
			if (mode === "janus" && !has_janus) {
				mode = "media";
			}
			if (mode === "media" && !has_media) {
				mode = "mjpeg";
			}
			tools.radio.clickValue("stream-mode-radio", mode);
		}

		if (state.streamer) {
			let s = state.streamer;
			__res = s.source.resolution;

			{
				let res = `${__res.width}x${__res.height}`;
				let el = $("stream-resolution-selector");
				if (!tools.selector.hasValue(el, res)) {
					tools.selector.addOption(el, res, res);
				}
				el.value = res;
			}
			tools.slider.setValue($("stream-quality-slider"), Math.max(s.encoder.quality, 1));
			tools.slider.setValue($("stream-desired-fps-slider"), s.source.desired_fps);
			if (s.h264 && s.h264.bitrate) {
				tools.slider.setValue($("stream-h264-bitrate-slider"), s.h264.bitrate);
				tools.slider.setValue($("stream-h264-gop-slider"), s.h264.gop); // Following together with gop
			}

			tools.feature.setEnabled($("stream-quality"), (s.encoder.quality > 0));

			__streamer.ensureStream(s);
		}
	};

	var __setActive = function() {
		$("stream-led").className = "led-green";
		$("stream-led").title = "Stream is active";
	};

	var __setInactive = function() {
		$("stream-led").className = "led-gray";
		$("stream-led").title = "Stream inactive";
	};

	var __setControlsEnabled = function(enabled) {
		tools.el.setEnabled($("stream-quality-slider"), enabled);
		tools.el.setEnabled($("stream-desired-fps-slider"), enabled);
		tools.el.setEnabled($("stream-resolution-selector"), enabled);
		tools.el.setEnabled($("stream-h264-bitrate-slider"), enabled);
		tools.el.setEnabled($("stream-h264-gop-slider"), enabled);
	};

	var __setInfo = function(is_active, online, text) {
		$("stream-box").classList.toggle("stream-box-offline", !online);
		let el_grab = document.querySelector("#stream-window-header .window-grab");
		let el_info = $("stream-info");
		let title = `${__streamer.getName()} - `;
		if (is_active) {
			if (!online) {
				title += "No signal / ";
			}
			title += `${__res.width}x${__res.height}`;
			if (text.length > 0) {
				title += " / " + text;
			}
		} else {
			if (text.length > 0) {
				title += text;
			} else {
				title += "Inactive";
			}
		}
		el_grab.innerText = el_info.innerText = title;
	};

	var __resetStream = function(mode=null) {
		if (mode === null) {
			mode = __streamer.getMode();
		}
		__streamer.stopStream();
		if (mode === "mjpeg") {
			// For mjpeg mode, create an instance of MjpegStreamer
			__streamer = new MjpegStreamer(__setActive, __setInactive, __setInfo);
			tools.feature.setEnabled($("stream-orient"), false);
			tools.feature.setEnabled($("stream-audio"), false); // Enabling in stream_janus.js
			tools.feature.setEnabled($("stream-mic"), false); // Ditto
		} else if (mode === "media") {
			// For media mode, create an instance of MediaStreamer
			__streamer = new MediaStreamer(__setActive, __setInactive, __setInfo);
			tools.feature.setEnabled($("stream-orient"), false);
			tools.feature.setEnabled($("stream-audio"), false); // Assuming this should be disabled for MediaStreamer as well
			tools.feature.setEnabled($("stream-mic"), false); // Ditto
		} else { // janus
			// For janus mode, create an instance of JanusStreamer with specific settings
			__streamer = new JanusStreamer(__setActive, __setInactive, __setInfo,
				tools.storage.getInt("stream.orient", 0), !$("stream-video").muted, $("stream-mic-switch").checked);
			// Firefox doesn't support RTP orientation:
			//  - https://bugzilla.mozilla.org/show_bug.cgi?id=1316448
			tools.feature.setEnabled($("stream-orient"), !tools.browser.is_firefox);
		}
		if (wm.isWindowVisible($("stream-window"))) {
			__streamer.ensureStream((__state && __state.streamer !== undefined) ? __state.streamer : null);
		}
	};

	var __clickModeRadio = function() {
		let mode = tools.radio.getValue("stream-mode-radio");
		tools.storage.set("stream.mode", mode);
		if (mode !== __streamer.getMode()) {
			tools.hidden.setVisible($("stream-canvas"), (mode === "media"));
			tools.hidden.setVisible($("stream-image"), (mode === "mjpeg"));
			tools.hidden.setVisible($("stream-video"), (mode === "janus"));
			__resetStream(mode);
		}
	};

	var __clickScreenshotButton = function() {
		let el = document.createElement("a");
		el.href = "/api/streamer/snapshot";
		el.target = "_blank";
		document.body.appendChild(el);
		el.click();
		setTimeout(() => document.body.removeChild(el), 0);
	};

	var __clickResetButton = function() {
		wm.confirm("Are you sure you want to reset stream?").then(function(ok) {
			if (ok) {
				__resetStream();
				tools.httpPost("/api/streamer/reset", null, function(http) {
					if (http.status !== 200) {
						wm.error("Can't reset stream", http.responseText);
					}
				});
			}
		});
	};

	
	var stream_mjpeg_refresh_img;
	var stream_now_fps
	let mediaRecorder;
	var __clickRecordStartButton = function() {
		wm.confirm("Are you sure you want to record stream?").then(function (ok) {
			if (ok) {
				stream_now_fps = tools.slider.getValue($("stream-desired-fps-slider"));
				let recordedBlobs = [];
				//"mjpeg" or "janus" or "media"
				let stream_type = document.querySelector('input[name="stream-mode-radio"]:checked').value;
				if ( stream_type == "mjpeg"){
					
					var stream_mjpeg_img = document.getElementById('stream-image');
					var stream_mjpeg_canvas = document.getElementById('stream-mjpeg-canvas');
					var ctx = stream_mjpeg_canvas.getContext('2d');
					stream_mjpeg_canvas.width = stream_mjpeg_img.width;
					stream_mjpeg_canvas.height = stream_mjpeg_img.height;
					const stream = stream_mjpeg_canvas.captureStream(stream_now_fps);
					mediaRecorder = new MediaRecorder(stream);
				}else if(stream_type == "media"){
					const stream_canvas = document.getElementById("stream-canvas")
					stream_canvas.captureStream = stream_canvas.captureStream || stream_canvas.mozCaptureStream;
					mediaRecorder = new MediaRecorder(stream_canvas.captureStream(stream_now_fps));
				}else if(stream_type == "janus"){
					const stream = document.getElementById("stream-video")
					stream.captureStream = stream.captureStream || stream.mozCaptureStream;
					mediaRecorder = new MediaRecorder(stream.captureStream());
				}
				
			  
				mediaRecorder.ondataavailable = function(event) {
					if (event.data && event.data.size > 0) {
						recordedBlobs.push(event.data);
					}
				};
			  
				mediaRecorder.onstop = function() {
					const blob = new Blob(recordedBlobs, {type: 'video/webm'});
					var url = URL.createObjectURL(blob);
					const a = document.createElement('a');
					document.body.appendChild(a);
					const now = new Date();
					const year = now.getFullYear();
					const month = ('0' + (now.getMonth() + 1)).slice(-2);
					const day = ('0' + now.getDate()).slice(-2);
					const hours = ('0' + now.getHours()).slice(-2);
					const minutes = ('0' + now.getMinutes()).slice(-2);
					const seconds = ('0' + now.getSeconds()).slice(-2);//Get now time
					a.style = "display: none";
					a.href = url;
					a.download = stream_type +"_"+ year + month + day + hours + minutes + seconds + ".webm";
					a.click();
					window.URL.revokeObjectURL(url);
				};
			  
				mediaRecorder.start();
				document.getElementById('stream-record-start-button').disabled = true;
				document.getElementById('stream-record-stop-button').disabled = false;
				if (stream_type == "mjpeg"){
					stream_mjpeg_refresh_img = setInterval(function() {
						ctx.drawImage(stream_mjpeg_img, 0, 0, stream_mjpeg_img.width, stream_mjpeg_img.height);
					}, 1000 / stream_now_fps);
				}
			}
		});
	};

	var __clickRecordStopButton = function() {
		mediaRecorder.stop();
		clearInterval(stream_mjpeg_refresh_img);
		document.getElementById('stream-record-start-button').disabled = false;
		document.getElementById('stream-record-stop-button').disabled = true;
	};

	let stopTxQrTransHandler = {
		stream_canvas_ctx: null,
		cancelAnimationFrameHandler: 0,
		txqrDecoder: null,
		displayDom: null,
		originalHTMLContent: "",
		stop: function() {
			if (this.stream_canvas_ctx && !this.stream_canvas_ctx.imageSmoothingEnabled) {
				this.stream_canvas_ctx.imageSmoothingEnabled = true;
			}
			if (this.cancelAnimationFrameHandler) {
				cancelAnimationFrame(this.cancelAnimationFrameHandler);
				this.cancelAnimationFrameHandler = 0;
			}
			if (this.txqrDecoder) {
				this.txqrDecoder.cancel();
				this.txqrDecoder = null;
			}
			if (this.displayDom) {
				this.displayDom.innerHTML = this.originalHTMLContent;
				this.displayDom = null;
			}
		}
	};

	var __clickTxqrStartButton = function() {
		wm.confirm("确定开启txqr文件传输吗? 要使用此功能, 你必须在被控主机上运行txqr文件传输程序!").then(function (ok) {
			if (ok) {
				const txqrDecoder = new qram.Decoder();
				const displayDom = $("txqr-text");
				let width = 0, height = 0, errorCount = 0;
				let stream_mjpeg_img, stream_canvas, canvas_ctx, video = null;

				stopTxQrTransHandler.txqrDecoder = txqrDecoder;
				stopTxQrTransHandler.displayDom = displayDom.children[1];
				stopTxQrTransHandler.originalHTMLContent = stopTxQrTransHandler.displayDom.innerHTML;

				stream_now_fps = tools.slider.getValue($("stream-desired-fps-slider"));
				//"mjpeg" or "janus" or "media"
				let stream_type = document.querySelector('input[name="stream-mode-radio"]:checked').value;
				if ( stream_type == "mjpeg"){
					stream_mjpeg_img = $('stream-image');
					stream_canvas = $('stream-mjpeg-canvas');
					canvas_ctx = stream_canvas.getContext('2d');
					// need crisp images for QR codes
					canvas_ctx.imageSmoothingEnabled = false;
					stream_canvas.width = width = stream_mjpeg_img.width;
					stream_canvas.height = height = stream_mjpeg_img.height;
				}else if(stream_type == "media"){
					stream_canvas = $("stream-canvas");
					canvas_ctx = stream_canvas.getContext('2d');
					// need crisp images for QR codes
					canvas_ctx.imageSmoothingEnabled = false;
					width = stream_canvas.width;
					height = stream_canvas.height;
				}else if(stream_type == "janus"){
					video = $("stream-video");
				}

				if (canvas_ctx) {
					stopTxQrTransHandler.stream_canvas_ctx = canvas_ctx;
				}

				var getImageData = function() {
					let data = null;
					if (stream_type == "mjpeg"){
						if (stream_mjpeg_img && stream_mjpeg_img.complete && stream_mjpeg_img.naturalWidth) {
							canvas_ctx.drawImage(stream_mjpeg_img, 0, 0, width, height);
						}
						data = canvas_ctx.getImageData(0, 0, width, height);
					}else if(stream_type == "media"){
						data = canvas_ctx.getImageData(0, 0, width, height);
					}else if(stream_type == "janus"){
						data = qram.getImageData(video);
					}
					return data;
				}

				stopTxQrTransHandler.cancelAnimationFrameHandler = requestAnimationFrame(function enqueue() {
					// use qram helper to get image data
					const imageData = getImageData();
					// use qr-code reader of choice to get Uint8Array or Uint8ClampedArray
					// representing the packet
					try {
						const data = jsQR(imageData.data, imageData.width, imageData.height);
						if (!data) {
							// no QR code found, reschedule to get another packet
							errorCount++;
							stopTxQrTransHandler.cancelAnimationFrameHandler = requestAnimationFrame(enqueue);
							return;
						}
						const text = data.data;
						// enqueue the packet data for decoding, ignoring any errors
						// and rescheduling until done or aborted
						txqrDecoder.enqueue(base64url.decode(text)).then(progress => {
							// show progress, e.g. `progress.receivedBlocks / progress.totalBlocks`,
							// to user somehow ...
							if(progress && progress.receivedBlocks && progress.totalBlocks) {
								displayDom.innerHTML = `TxQr传输开始, 进度: ${progress.receivedBlocks} / ${progress.totalBlocks}, 错误数: ${errorCount}`;
							}
							if(progress && !progress.done) {
								// not done yet, schedule to get another packet
								stopTxQrTransHandler.cancelAnimationFrameHandler = requestAnimationFrame(enqueue);
							}
						}).catch(e => {
							if (e.name != 'AbortError') {
								stopTxQrTransHandler.cancelAnimationFrameHandler = requestAnimationFrame(enqueue)
							}
						});
					} catch (e) {
						console.error(e);
						__clickTxqrStopButton();
						wm.error(`TxQr传输时出错, 详情请查看控制台日志. 参考信息: <br> ${e.message}`);
					}
				});

				txqrDecoder.decode().then(res => {
					if (res && res.done && res.data) {
						// 传输成功
						const {data} = res;
						saveUint8ArrayToFile(data, "txqr-file.bin");
						__clickTxqrStopButton();
						return wm.modal("传输成功!", `
							<p>文件传输成功, 但仍需你根据实际对文件进行重命名</p>
							`, true, true);
						// stopTxQrTransHandler.stop();
					} else {
						__clickTxqrStopButton();
						return wm.modal("传输结束", `
							<p>文件传输时发生了未知的错误</p>
							`, true, true);
					}
					// decoder is ready, start receiving packets
					// txqrDecoder.enqueue(...)
				}).catch(e => {
					// stopTxQrTransHandler.stop();
					__clickTxqrStopButton();
					console.error(e);
					if (e.name == 'AbortError') {
						wm.error(`TxQr解码错误, 错误信息: <br> ${e.message}`);
					}
				});

				$('txqr-start-button').disabled = true;
				$('txqr-stop-button').disabled = false;
			}
		});
	}

	var __clickTxqrStopButton = function() {
		stopTxQrTransHandler.stop();

		$('txqr-start-button').disabled = false;
		$('txqr-stop-button').disabled = true;
	}

	var __sendParam = function(name, value) {
		tools.httpPost("/api/streamer/set_params", {[name]: value}, function(http) {
			if (http.status !== 200) {
				wm.error("Can't configure stream", http.responseText);
			}
		});
	};

	__init__();
}
