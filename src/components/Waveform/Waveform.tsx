import { clamp, floor, head, isEmpty, isNil } from 'lodash';
import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  PanResponder,
  Platform,
  ScrollView,
  View,
  type LayoutRectangle,
  type NativeTouchEvent,
} from 'react-native';
import RNFetchBlob, { type FetchBlobResponse } from 'rn-fetch-blob';
import {
  DurationType,
  FinishMode,
  PermissionStatus,
  playbackSpeedThreshold,
  PlayerState,
  RecorderState,
  UpdateFrequency,
} from '../../constants';
import {
  useAudioPermission,
  useAudioPlayer,
  useAudioRecorder,
} from '../../hooks';
import type { IStartRecording } from '../../types';
import { WaveformCandle } from '../WaveformCandle';
import styles from './WaveformStyles';
import {
  type IStartPlayerRef,
  type IWaveform,
  type IWaveformRef,
  type LiveWaveform,
  type StaticWaveform,
} from './WaveformTypes';

// Cache directory based on the platform
const cacheDir: string =
  Platform.OS === 'ios'
    ? RNFetchBlob.fs.dirs.DocumentDir
    : RNFetchBlob.fs.dirs.CacheDir;

export const Waveform = forwardRef<IWaveformRef, IWaveform>((props, ref) => {
  const {
    // The maximum number of candles set in the waveform. Once this limit is reached, the oldest candle will be removed as a new one is added to the waveform.
    maxCandlesToRender = 300,
    mode,
    path,
    volume = 3,
    // The playback speed of the audio player. A value of 1.0 represents normal playback speed.
    playbackSpeed = 1.0,
    isExternalUrl = false,
    downloadExternalAudio = true,
    candleSpace = 2,
    candleWidth = 5,
    containerStyle = {},
    waveColor,
    scrubColor,
    onPlayerStateChange,
    onRecorderStateChange,
    onPanStateChange = () => {},
    onError = () => {},
    onCurrentProgressChange = () => {},
    candleHeightScale = 3,
    onChangeWaveformLoadState,
    onDownloadStateChange,
    onDownloadProgressChange,
  } = props as StaticWaveform & LiveWaveform;
  const viewRef = useRef<View>(null);
  const [audioPath, setAudioPath] = useState<string | undefined>(
    !isExternalUrl ? path : undefined
  );
  const scrollRef = useRef<ScrollView>(null);
  const isLayoutCalculated = useRef<boolean>(false);
  const audioPathRef = useRef<string | undefined>(undefined);
  const [waveform, setWaveform] = useState<number[]>([]);
  const [viewLayout, setViewLayout] = useState<LayoutRectangle | null>(null);
  const [seekPosition, setSeekPosition] = useState<NativeTouchEvent | null>(
    null
  );
  const [songDuration, setSongDuration] = useState<number>(0);
  const [noOfSamples, setNoOfSamples] = useState<number>(0);
  const [currentProgress, setCurrentProgress] = useState<number>(0);
  const [panMoving, setPanMoving] = useState(false);
  const [playerState, setPlayerState] = useState(PlayerState.stopped);
  const [recorderState, setRecorderState] = useState(RecorderState.stopped);
  const audioSpeed: number =
    playbackSpeed > playbackSpeedThreshold ? 1.0 : playbackSpeed;

  const {
    extractWaveformData,
    preparePlayer,
    getDuration,
    seekToPlayer,
    playPlayer,
    stopPlayer,
    pausePlayer,
    onCurrentDuration,
    onDidFinishPlayingAudio,
    onCurrentRecordingWaveformData,
    setPlaybackSpeed,
    markPlayerAsUnmounted,
  } = useAudioPlayer();

  const { startRecording, stopRecording, pauseRecording, resumeRecording } =
    useAudioRecorder();

  const { checkHasAudioRecorderPermission } = useAudioPermission();

  /**
   * Updates the playback speed of the audio player.
   *
   * @param speed - The new playback speed to set.
   * @returns A Promise that resolves when the playback speed has been updated.
   * @throws An error if there was a problem updating the playback speed.
   */
  const updatePlaybackSpeed = async (speed: number) => {
    try {
      await setPlaybackSpeed({ speed, playerKey: `PlayerFor${audioPath}` });
    } catch (error) {
      console.error('Error updating playback speed', error);
    }
  };

  useEffect(() => {
    if (audioPath !== undefined) {
      updatePlaybackSpeed(audioSpeed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioSpeed, audioPath]);

  const setExternalAudioPath = (filePath: string): void => {
    setAudioPath(filePath);
    audioPathRef.current = filePath;
    (onDownloadStateChange as Function)?.(false);
    (onDownloadProgressChange as Function)?.(100);
  };

  /**
   * Downloads the audio file and caches it in the cache directory.
   * @param fileUrl - The URL of the audio file to download.
   * @param fileName - The name of the audio file to use in the cache directory.
   * @returns A Promise that resolves when the audio file has been downloaded and cached.
   */
  const downloadAndCacheFile = async (
    fileUrl: string,
    fileName: string
  ): Promise<void> => {
    const filePath: string = `${cacheDir}/${fileName}`;

    try {
      const fileExists: boolean = await RNFetchBlob.fs.exists(filePath);

      if (fileExists) {
        setExternalAudioPath(filePath);
        return;
      }

      // File doesn't exist, download it
      (onDownloadStateChange as Function)?.(true);
      await RNFetchBlob.config({
        path: filePath,
        fileCache: true,
      })
        .fetch('GET', fileUrl)
        .progress((received: number, total: number) => {
          let progressPercentage: number = Number(
            ((received / total) * 100)?.toFixed?.(2)
          );
          (onDownloadProgressChange as Function)?.(progressPercentage);
        })
        .then((response: FetchBlobResponse) => {
          const tempFilePath: string = response.path();
          setExternalAudioPath(tempFilePath);
        })
        .catch(error => {
          console.error(error);
          (onDownloadStateChange as Function)?.(false);
        });
    } catch (error) {
      console.error(error);
    }
  };

  const checkIsFileDownloaded = async (fileName: string): Promise<void> => {
    const filePath: string = `${cacheDir}/${fileName}`;
    const fileExists: boolean = await RNFetchBlob.fs.exists(filePath);
    if (fileExists) {
      setExternalAudioPath(filePath);
    }
  };

  // Replace special characters with _ and remove extension from the URL and make file name lowercase
  const formatUrlToFileName = (url: string): string => {
    return url
      ?.replace?.(/[:\/\.\%20\-~\?=&@#\!\$\^\*\(\)\{\}\[\],\'"]/g, '_')
      ?.replace?.(/\.[^/.]+$/, '')
      ?.toLowerCase?.();
  };

  useEffect(() => {
    const fileName: string = formatUrlToFileName(path);

    if (isExternalUrl && path && downloadExternalAudio) {
      downloadAndCacheFile(path, fileName);
    } else if (isExternalUrl && path) {
      checkIsFileDownloaded(fileName);
    } else {
      (onDownloadStateChange as Function)?.(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isExternalUrl, path, downloadExternalAudio]);

  const preparePlayerForPath = async (progress?: number) => {
    if (!isNil(audioPath) && !isEmpty(audioPath)) {
      try {
        const prepare = await preparePlayer({
          path: audioPath,
          playerKey: `PlayerFor${audioPath}`,
          updateFrequency: UpdateFrequency.medium,
          volume: volume,
          progress,
        });
        return Promise.resolve(prepare);
      } catch (err) {
        return Promise.reject(err);
      }
    } else {
      return Promise.reject(
        new Error(`Can not start player for path: ${audioPath}`)
      );
    }
  };

  const getAudioDuration = async () => {
    try {
      const duration = await getDuration({
        playerKey: `PlayerFor${audioPath}`,
        durationType: DurationType.max,
      });
      if (!isNil(duration)) {
        const audioDuration = Number(duration);
        setSongDuration(audioDuration > 0 ? audioDuration : 0);
        return Promise.resolve(audioDuration);
      } else {
        return Promise.reject(
          new Error(`Could not get duration for path: ${audioPath}`)
        );
      }
    } catch (err) {
      return Promise.reject(err);
    }
  };

  const preparePlayerAndGetDuration = async () => {
    try {
      const prepare = await preparePlayerForPath();
      if (prepare) {
        const duration = await getAudioDuration();
        if (duration < 0) {
          await getAudioDuration();
        }
      }
    } catch (err) {
      console.error(err);
      (onError as Function)(err);
    }
  };

  const getAudioWaveFormForPath = async (noOfSample: number) => {
    if (!isNil(audioPath) && !isEmpty(audioPath)) {
      try {
        (onChangeWaveformLoadState as Function)?.(true);
        const result = await extractWaveformData({
          path: audioPath,
          playerKey: `PlayerFor${audioPath}`,
          noOfSamples: noOfSample,
        });
        (onChangeWaveformLoadState as Function)?.(false);

        if (!isNil(result) && !isEmpty(result)) {
          const waveforms = head(result);
          if (!isNil(waveforms) && !isEmpty(waveforms)) {
            setWaveform(waveforms);
            await preparePlayerAndGetDuration();
          }
        }
      } catch (err) {
        (onError as Function)(err);
        (onChangeWaveformLoadState as Function)?.(false);
        console.error(err);
      }
    } else {
      (onError as Function)(
        `Can not find waveform for mode ${mode} path: ${audioPath}`
      );
      console.error(
        `Can not find waveform for mode ${mode} path: ${audioPath}`
      );
    }
  };

  const stopPlayerAction = async () => {
    if (mode === 'static') {
      try {
        const result = await stopPlayer({
          playerKey: `PlayerFor${audioPath}`,
        });
        if (!isNil(result) && result) {
          setCurrentProgress(0);
          setPlayerState(PlayerState.stopped);
          return Promise.resolve(result);
        } else {
          return Promise.reject(
            new Error(`error in stopping player for path: ${audioPath}`)
          );
        }
      } catch (err) {
        return Promise.reject(err);
      }
    } else {
      return Promise.reject(
        new Error('error in stopping player: mode is not static')
      );
    }
  };

  const startPlayerAction = async (args?: IStartPlayerRef) => {
    if (mode === 'static') {
      try {
        if (playerState === PlayerState.stopped) {
          await preparePlayerForPath(currentProgress);
        }

        const play = await playPlayer({
          finishMode: FinishMode.stop,
          playerKey: `PlayerFor${audioPath}`,
          path: audioPath,
          speed: audioSpeed,
          ...args,
        });

        if (play) {
          setPlayerState(PlayerState.playing);
          return Promise.resolve(true);
        } else {
          return Promise.reject(
            new Error(`error in starting player for path: ${audioPath}`)
          );
        }
      } catch (error) {
        return Promise.reject(error);
      }
    } else {
      return Promise.reject(
        new Error('error in starting player: mode is not static')
      );
    }
  };

  const pausePlayerAction = async () => {
    if (mode === 'static') {
      try {
        const pause = await pausePlayer({
          playerKey: `PlayerFor${audioPath}`,
        });
        if (pause) {
          setPlayerState(PlayerState.paused);
          return Promise.resolve(true);
        } else {
          return Promise.reject(
            new Error(`error in pause player for path: ${audioPath}`)
          );
        }
      } catch (error) {
        return Promise.reject(error);
      }
    } else {
      return Promise.reject(
        new Error('error in pausing player: mode is not static')
      );
    }
  };

  const startRecordingAction = async (args?: Partial<IStartRecording>) => {
    if (mode === 'live') {
      try {
        const hasPermission = await checkHasAudioRecorderPermission();

        if (hasPermission === PermissionStatus.granted) {
          const start = await startRecording(args);
          if (!isNil(start) && start) {
            setRecorderState(RecorderState.recording);
            return Promise.resolve(true);
          } else {
            return Promise.reject(new Error('error in start recording action'));
          }
        } else {
          return Promise.reject(
            new Error(
              'error in start recording: audio recording permission is not granted'
            )
          );
        }
      } catch (err) {
        return Promise.reject(err);
      }
    } else {
      return Promise.reject(
        new Error('error in start recording: mode is not live')
      );
    }
  };

  const stopRecordingAction = async () => {
    if (mode === 'live') {
      try {
        const data = await stopRecording();
        if (!isNil(data) && !isEmpty(data)) {
          setWaveform([]);
          const pathData = head(data);
          if (!isNil(pathData)) {
            setRecorderState(RecorderState.stopped);
            return Promise.resolve(pathData);
          } else {
            return Promise.reject(
              new Error(
                'error in stopping recording. can not get path of recording'
              )
            );
          }
        } else {
          return Promise.reject(
            new Error(
              'error in stopping recording. can not get path of recording'
            )
          );
        }
      } catch (err) {
        return Promise.reject(err);
      }
    } else {
      return Promise.reject(
        new Error('error in stop recording: mode is not live')
      );
    }
  };

  const pauseRecordingAction = async () => {
    if (mode === 'live') {
      try {
        const pause = await pauseRecording();
        if (!isNil(pause) && pause) {
          setRecorderState(RecorderState.paused);
          return Promise.resolve(pause);
        } else {
          return Promise.reject(new Error('Error in pausing recording audio'));
        }
      } catch (err) {
        return Promise.reject(err);
      }
    } else {
      return Promise.reject(
        new Error('error in pause recording: mode is not live')
      );
    }
  };

  const resumeRecordingAction = async () => {
    if (mode === 'live') {
      try {
        const hasPermission = await checkHasAudioRecorderPermission();
        if (hasPermission === PermissionStatus.granted) {
          const resume = await resumeRecording();
          if (!isNil(resume)) {
            setRecorderState(RecorderState.recording);
            return Promise.resolve(resume);
          } else {
            return Promise.reject(new Error('Error in resume recording'));
          }
        } else {
          return Promise.reject(
            new Error(
              'error in resume recording: audio recording permission is not granted'
            )
          );
        }
      } catch (err) {
        return Promise.reject(err);
      }
    } else {
      return Promise.reject(
        new Error('error in resume recording: mode is not live')
      );
    }
  };

  useEffect(() => {
    if (!isNil(viewLayout?.width) && audioPath !== undefined) {
      const getNumberOfSamples = floor(
        (viewLayout?.width ?? 0) / (candleWidth + candleSpace)
      );

      // when orientation changes, the layout needs to be recalculated
      if (viewLayout?.x === 0 && viewLayout?.y === 0) {
        isLayoutCalculated.current = false;
      }

      setNoOfSamples(getNumberOfSamples);
      if (mode === 'static') {
        getAudioWaveFormForPath(getNumberOfSamples);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewLayout?.width, mode, candleWidth, candleSpace, audioPath]);

  useEffect(() => {
    if (!isNil(seekPosition) && audioPath !== undefined) {
      if (mode === 'static') {
        const seekAmount =
          (seekPosition?.pageX - (viewLayout?.x ?? 0)) /
          (viewLayout?.width ?? 1);
        const clampedSeekAmount = clamp(seekAmount, 0, 1);

        if (!panMoving) {
          seekToPlayer({
            playerKey: `PlayerFor${audioPath}`,
            progress: clampedSeekAmount * songDuration,
          });
          if (playerState === PlayerState.playing) {
            startPlayerAction();
          }
        }

        setCurrentProgress(clampedSeekAmount * songDuration);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekPosition, panMoving, mode, songDuration, audioPath]);

  useEffect(() => {
    if (audioPath !== undefined) {
      const tracePlayerState = onDidFinishPlayingAudio(async data => {
        if (data.playerKey === `PlayerFor${audioPath}`) {
          if (data.finishType === FinishMode.stop) {
            setPlayerState(PlayerState.stopped);
            setCurrentProgress(0);
          }
        }
      });

      const tracePlaybackValue = onCurrentDuration(data => {
        if (data.playerKey === `PlayerFor${audioPath}`) {
          const currentAudioDuration = Number(data.currentDuration);

          if (!isNaN(currentAudioDuration)) {
            setCurrentProgress(currentAudioDuration);
          } else {
            setCurrentProgress(0);
          }
        }
      });

      return () => {
        tracePlayerState.remove();
        tracePlaybackValue.remove();
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioPath]);

  useEffect(() => {
    const traceRecorderWaveformValue = onCurrentRecordingWaveformData(
      result => {
        if (mode === 'live') {
          if (!isNil(result.currentDecibel)) {
            setWaveform((previousWaveform: number[]) => {
              // Add the new decibel to the waveform
              const updatedWaveform: number[] = [
                ...previousWaveform,
                result.currentDecibel,
              ];

              // Limit the size of the waveform array to 'maxCandlesToRender'
              return updatedWaveform.length > maxCandlesToRender
                ? updatedWaveform.slice(1)
                : updatedWaveform;
            });
            if (scrollRef.current) {
              scrollRef.current.scrollToEnd({ animated: true });
            }
          }
        }
      }
    );

    return () => {
      traceRecorderWaveformValue.remove();
      markPlayerAsUnmounted();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isNil(onPlayerStateChange)) {
      (onPlayerStateChange as Function)(playerState);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerState]);

  useEffect(() => {
    if (!isNil(onRecorderStateChange)) {
      (onRecorderStateChange as Function)(recorderState);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorderState]);

  useEffect(() => {
    if (audioPath !== undefined) {
      if (panMoving) {
        if (playerState === PlayerState.playing) {
          pausePlayerAction();
        }
      } else {
        if (playerState === PlayerState.paused) {
          startPlayerAction();
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panMoving, audioPath]);

  const calculateLayout = (): void => {
    viewRef.current?.measureInWindow((x, y, width, height) => {
      setViewLayout({ x, y, width, height });
      if (x !== 0 || y !== 0) {
        // found the position of view in window
        isLayoutCalculated.current = true;
      }
    });
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => {
        if (!isLayoutCalculated.current) {
          calculateLayout();
        }

        return true;
      },
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        setPanMoving(true);
        (onPanStateChange as Function)(true);
      },
      onPanResponderStart: () => {},
      onPanResponderMove: event => {
        setSeekPosition(event.nativeEvent);
      },
      onPanResponderEnd: () => {
        (onPanStateChange as Function)(false);
        setPanMoving(false);
      },
    })
  ).current;

  useEffect(() => {
    if (!isNil(onCurrentProgressChange)) {
      (onCurrentProgressChange as Function)(currentProgress, songDuration);
    }
  }, [currentProgress, songDuration, onCurrentProgressChange]);

  useImperativeHandle(ref, () => ({
    startPlayer: startPlayerAction,
    stopPlayer: stopPlayerAction,
    pausePlayer: pausePlayerAction,
    resumePlayer: startPlayerAction,
    startRecord: startRecordingAction,
    pauseRecord: pauseRecordingAction,
    stopRecord: stopRecordingAction,
    resumeRecord: resumeRecordingAction,
  }));

  return (
    <View style={[styles.waveformContainer, containerStyle]}>
      <View
        ref={viewRef}
        style={styles.waveformInnerContainer}
        onLayout={calculateLayout}
        {...(mode === 'static' ? panResponder.panHandlers : {})}>
        <ScrollView
          horizontal
          ref={scrollRef}
          style={styles.scrollContainer}
          scrollEnabled={mode === 'live'}>
          {waveform?.map?.((amplitude, indexCandle) => (
            <WaveformCandle
              key={indexCandle}
              index={indexCandle}
              amplitude={amplitude}
              parentViewLayout={viewLayout}
              {...{
                candleWidth,
                candleSpace,
                noOfSamples,
                songDuration,
                currentProgress,
                waveColor,
                scrubColor,
                candleHeightScale,
              }}
            />
          ))}
        </ScrollView>
      </View>
    </View>
  );
});
