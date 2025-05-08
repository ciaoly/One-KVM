/*****************************************************************************
#                                                                            #
#    KVMD - The main PiKVM daemon.                                           #
#                                                                            #
#    Copyright (C) 2018-2024  Maxim Devaev <mdevaev@gmail.com>               #
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
import { qram, jsQR, base64url, saveUint8ArrayToFile } from "./qram-one-kvm.min.js";


export function TxQR(__getGeometry) {
	var self = this;

	/************************************************************************/

	var __init__ = function() {
		tools.el.setOnClick($("txqr-start-button"), __clickTxqrStartButton);
		tools.el.setOnClick($("txqr-stop-button"), __clickTxqrStopButton);

		document.getElementById('txqr-stop-button').disabled = true;
	};

	/************************************************************************/

	
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
							if(progress && progress.receivedBlocks >= 0 && progress.totalBlocks) {
								stopTxQrTransHandler.displayDom.innerHTML = `TxQr传输开始, 进度: ${progress.receivedBlocks} / ${progress.totalBlocks}, 错误数: ${errorCount}`;
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

	__init__();
}
